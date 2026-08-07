import dbQuery, { pool } from '../db/dbQuery';
import { db } from '../config';
import { createNotification } from './notification.service';
import { emitSupportCaseUpdated } from './supportRealtimeService';
import { INTERNAL_CASE_STATES, PROVIDER_CASE_STATES, RESOLUTION_CODES } from './supportCasePolicy';
import { writeEvent as writeAuditEvent } from './adminAuditService';

const s = db.schema;
const fail = (message: string, code: string, statusCode: number) => Object.assign(new Error(message), { code, statusCode });
const safeText = (value: unknown, max: number, field: string) => {
  const result = String(value ?? '').trim();
  if (!result || result.length > max) throw fail(`${field} is required and must not exceed ${max} characters.`, 'INVALID_CONTENT', 422);
  return result;
};
const validVersion = (value: unknown) => {
  const version = Number(value);
  if (!Number.isInteger(version) || version < 1) throw fail('Current case version is required.', 'INVALID_VERSION', 400);
  return version;
};

const audit = (adminUid: string, caseId: string, action: string, after?: Record<string, unknown>) =>
  writeAuditEvent({ action, actionCategory: 'support', outcome: 'success', actorUid: adminUid,
    actorType: 'admin', entityType: 'support_case', entityId: caseId, after: after ?? null,
    source: 'admin_portal' }).catch(() => undefined);

export async function listAdminCases(filters: Record<string, unknown>) {
  const limit = Math.max(1, Math.min(Number(filters.limit ?? 25), 100));
  const values: any[] = [];
  const where: string[] = [];
  for (const [field, column] of [['domain','c.domain'],['queue','c.current_queue'],['state','c.internal_state'],['severity','c.severity']] as const) {
    if (filters[field]) { values.push(String(filters[field]).toUpperCase()); where.push(`${column} = $${values.length}`); }
  }
  if (filters.providerUid) { values.push(String(filters.providerUid)); where.push(`c.provider_uid = $${values.length}`); }
  if (filters.actionRequired === 'true') where.push('c.provider_action_required = TRUE');
  if (filters.slaBreached === 'true') where.push(`c.escalation_due_at < NOW() AND c.internal_state NOT IN ('RESOLVED','CLOSED')`);
  values.push(limit);
  const result = await dbQuery.query(
    `SELECT c.case_id,c.public_reference,c.provider_uid,c.domain,c.category_id,cat.provider_title,
            c.title,c.provider_state,c.internal_state,c.severity,c.priority,c.current_queue,
            c.provider_action_required,c.escalation_state,c.escalation_due_at,c.version,c.created_at,c.updated_at
       FROM ${s}.provider_support_cases c JOIN ${s}.support_case_categories cat ON cat.category_id = c.category_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY CASE c.severity WHEN 'CRITICAL' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'MODERATE' THEN 2 ELSE 3 END,
               c.provider_action_required DESC,c.created_at ASC LIMIT $${values.length}`, values,
  );
  return result.rows.map((row: any) => ({
    caseId: String(row.case_id), reference: row.public_reference, providerUid: row.provider_uid,
    domain: row.domain, categoryId: row.category_id, categoryTitle: row.provider_title,
    title: row.title, providerState: row.provider_state, internalState: row.internal_state,
    severity: row.severity, priority: row.priority, queue: row.current_queue,
    providerActionRequired: Boolean(row.provider_action_required), escalationState: row.escalation_state,
    escalationDueAt: row.escalation_due_at, version: Number(row.version),
    createdAt: row.created_at, updatedAt: row.updated_at,
  }));
}

export async function getAdminCase(caseId: string) {
  const found = await dbQuery.query(
    `SELECT c.*,cat.provider_title,cat.provider_description FROM ${s}.provider_support_cases c
      JOIN ${s}.support_case_categories cat ON cat.category_id = c.category_id WHERE c.case_id = $1`, [caseId],
  );
  if (!found.rowCount) throw fail('Support case not found.', 'CASE_NOT_FOUND', 404);
  const [sources,messages,notes,events,attachments,resolutions,appeals,escalations] = await Promise.all([
    dbQuery.query(`SELECT * FROM ${s}.support_case_sources WHERE case_id = $1 ORDER BY linked_at`, [caseId]),
    dbQuery.query(`SELECT message_id,sender_type,sender_uid,provider_visible_body,created_at FROM ${s}.support_case_messages WHERE case_id = $1 ORDER BY created_at,message_id`, [caseId]),
    dbQuery.query(`SELECT note_id,admin_uid,note_body,created_at FROM ${s}.support_case_internal_notes WHERE case_id = $1 ORDER BY created_at,note_id`, [caseId]),
    dbQuery.query(`SELECT event_id,event_type,actor_type,actor_uid,provider_visible,provider_label,public_detail,restricted_detail,created_at FROM ${s}.support_case_events WHERE case_id = $1 ORDER BY created_at,event_id`, [caseId]),
    dbQuery.query(`SELECT attachment_id,safe_file_name,mime_type,byte_size,evidence_class,scan_status,state,created_at FROM ${s}.support_case_attachments WHERE case_id = $1 ORDER BY created_at`, [caseId]),
    dbQuery.query(`SELECT * FROM ${s}.support_case_resolutions WHERE case_id = $1 ORDER BY applied_at`, [caseId]),
    dbQuery.query(`SELECT appeal_id,resolution_id,ground,explanation,state,provider_reason_code,provider_reason_detail,submitted_at,decided_at,version FROM ${s}.support_case_appeals WHERE case_id = $1 ORDER BY submitted_at`, [caseId]),
    dbQuery.query(`SELECT * FROM ${s}.support_case_escalations WHERE case_id = $1 ORDER BY created_at`, [caseId]),
  ]);
  return { ...found.rows[0], caseId: String(found.rows[0].case_id),
    sources: sources.rows, messages: messages.rows, internalNotes: notes.rows,
    events: events.rows, attachments: attachments.rows, resolutions: resolutions.rows,
    appeals: appeals.rows, escalations: escalations.rows };
}

export async function addAdminMessage(adminUid: string, caseId: string, input: Record<string, unknown>) {
  const body = safeText(input.message, 4000, 'Provider-visible message');
  const expectedVersion = validVersion(input.expectedVersion);
  const clientRequestId = safeText(input.clientRequestId, 128, 'Client request id');
  const requiresAction = Boolean(input.requiresProviderAction);
  const client = await pool.connect();
  let providerUid = '';
  try {
    await client.query('BEGIN');
    const replay = await client.query(`SELECT 1 FROM ${s}.support_case_messages WHERE case_id = $1 AND sender_type = 'SUPPORT' AND client_request_id = $2`, [caseId, clientRequestId]);
    if (replay.rowCount) { await client.query('COMMIT'); return getAdminCase(caseId); }
    const updated = await client.query(
      `UPDATE ${s}.provider_support_cases SET provider_state = $2, internal_state = $3,
              provider_action_required = $4, servana_action_required = $5,
              updated_at = NOW(),last_provider_visible_update_at = NOW(),version = version + 1
        WHERE case_id = $1 AND version = $6 AND internal_state NOT IN ('CLOSED') RETURNING provider_uid,version`,
      [caseId, requiresAction ? 'WAITING_FOR_PROVIDER' : 'UNDER_REVIEW', requiresAction ? 'AWAITING_EVIDENCE' : 'INVESTIGATING', requiresAction, !requiresAction, expectedVersion],
    );
    if (!updated.rowCount) throw fail('Case changed. Refresh before replying.', 'CASE_VERSION_CONFLICT', 409);
    providerUid = String(updated.rows[0].provider_uid);
    await client.query(`INSERT INTO ${s}.support_case_messages (case_id,sender_type,sender_uid,provider_visible_body,client_request_id) VALUES ($1,'SUPPORT',$2,$3,$4)`, [caseId,adminUid,body,clientRequestId]);
    await client.query(
      `INSERT INTO ${s}.support_case_events (case_id,event_type,actor_type,actor_uid,provider_label,public_detail,idempotency_key)
       VALUES ($1,$2,'ADMIN',$3,$4,$5::jsonb,$6)`,
      [caseId,requiresAction ? 'INFORMATION_REQUESTED' : 'SUPPORT_REPLIED',adminUid,
       requiresAction ? 'Information requested' : 'Servana replied',JSON.stringify({ requiresProviderAction: requiresAction }),`admin-message:${clientRequestId}`],
    );
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  audit(adminUid,caseId,'support_provider_message_sent',{ requiresAction });
  emitSupportCaseUpdated(providerUid,caseId,requiresAction ? 'INFORMATION_REQUESTED' : 'SUPPORT_REPLIED');
  void createNotification(providerUid,{ notificationKey:`support-message:${caseId}:${clientRequestId}`.slice(0,64),type:requiresAction?'SUPPORT_ACTION_REQUIRED':'SUPPORT_REPLY',severity:requiresAction?'high':'info',title:requiresAction?'Support case needs information':'Support case updated',safeBody:requiresAction?'Open Support Center to review the information requested.':'A provider-visible update is available in Support Center.',safeContextLabel:'Support Center',route:{screen:'SupportCase',caseId},canOpenDetail:true }).catch(()=>undefined);
  return getAdminCase(caseId);
}

export async function addInternalNote(adminUid: string, caseId: string, input: Record<string, unknown>) {
  const note = safeText(input.note, 4000, 'Internal note');
  const found = await dbQuery.query(`SELECT 1 FROM ${s}.provider_support_cases WHERE case_id = $1`, [caseId]);
  if (!found.rowCount) throw fail('Support case not found.', 'CASE_NOT_FOUND', 404);
  await dbQuery.query(`INSERT INTO ${s}.support_case_internal_notes(case_id,admin_uid,note_body) VALUES ($1,$2,$3)`, [caseId,adminUid,note]);
  await dbQuery.query(`INSERT INTO ${s}.support_case_events(case_id,event_type,actor_type,actor_uid,provider_visible,restricted_detail) VALUES ($1,'INTERNAL_NOTE_ADDED','ADMIN',$2,FALSE,$3::jsonb)`, [caseId,adminUid,JSON.stringify({ noteIdRecorded: true })]);
  audit(adminUid,caseId,'support_internal_note_added');
  return getAdminCase(caseId);
}

export async function transitionCase(adminUid: string, caseId: string, input: Record<string, unknown>) {
  const expectedVersion = validVersion(input.expectedVersion);
  const providerState = String(input.providerState ?? '').toUpperCase();
  const internalState = String(input.internalState ?? '').toUpperCase();
  if (!(PROVIDER_CASE_STATES as readonly string[]).includes(providerState)) throw fail('Invalid provider-facing state.', 'INVALID_PROVIDER_STATE', 422);
  if (!(INTERNAL_CASE_STATES as readonly string[]).includes(internalState)) throw fail('Invalid internal state.', 'INVALID_INTERNAL_STATE', 422);
  const publicExplanation = safeText(input.providerExplanation,1000,'Provider-facing explanation');
  const providerActionRequired = Boolean(input.providerActionRequired);
  const result = await dbQuery.query(
    `UPDATE ${s}.provider_support_cases SET provider_state=$2,internal_state=$3,
            provider_action_required=$4,servana_action_required=$5,updated_at=NOW(),
            last_provider_visible_update_at=NOW(),version=version+1
      WHERE case_id=$1 AND version=$6 RETURNING provider_uid,version`,
    [caseId,providerState,internalState,providerActionRequired,!providerActionRequired,expectedVersion],
  );
  if (!result.rowCount) throw fail('Case changed. Refresh before updating.', 'CASE_VERSION_CONFLICT', 409);
  const providerUid=String(result.rows[0].provider_uid);
  await dbQuery.query(
    `INSERT INTO ${s}.support_case_events(case_id,event_type,actor_type,actor_uid,provider_label,public_detail)
     VALUES ($1,'CASE_STATE_UPDATED','ADMIN',$2,'Case status updated',$3::jsonb)`,
    [caseId,adminUid,JSON.stringify({ state:providerState,explanation:publicExplanation,providerActionRequired })],
  );
  audit(adminUid,caseId,'support_case_state_updated',{providerState,internalState});
  emitSupportCaseUpdated(providerUid,caseId,'CASE_STATE_UPDATED');
  return getAdminCase(caseId);
}

export async function escalateCase(adminUid: string, caseId: string, input: Record<string, unknown>) {
  const expectedVersion=validVersion(input.expectedVersion);
  const destinationQueue=safeText(input.destinationQueue,64,'Destination queue').toUpperCase().replace(/[^A-Z0-9_]/g,'_');
  const escalationType=safeText(input.escalationType,32,'Escalation type').toUpperCase();
  const triggerCode=safeText(input.triggerCode,64,'Escalation reason').toUpperCase().replace(/[^A-Z0-9_]/g,'_');
  const client=await pool.connect(); let providerUid='';
  try {
    await client.query('BEGIN');
    const found=await client.query(`SELECT provider_uid,current_queue FROM ${s}.provider_support_cases WHERE case_id=$1 AND version=$2 FOR UPDATE`,[caseId,expectedVersion]);
    if(!found.rowCount) throw fail('Case changed. Refresh before escalating.','CASE_VERSION_CONFLICT',409);
    providerUid=String(found.rows[0].provider_uid);
    if(String(found.rows[0].current_queue)===destinationQueue) throw fail('Case is already in this queue.','ESCALATION_LOOP_BLOCKED',409);
    await client.query(`UPDATE ${s}.support_case_escalations SET state='ENDED',ended_at=NOW() WHERE case_id=$1 AND state='ACTIVE'`,[caseId]);
    await client.query(`INSERT INTO ${s}.support_case_escalations(case_id,escalation_type,source_queue,destination_queue,trigger_code,created_by_uid) VALUES ($1,$2,$3,$4,$5,$6)`,[caseId,escalationType,found.rows[0].current_queue,destinationQueue,triggerCode,adminUid]);
    await client.query(`UPDATE ${s}.provider_support_cases SET current_queue=$2,provider_state='ESCALATED',internal_state='ESCALATED',escalation_state='ACTIVE',updated_at=NOW(),last_provider_visible_update_at=NOW(),version=version+1 WHERE case_id=$1`,[caseId,destinationQueue]);
    await client.query(`INSERT INTO ${s}.support_case_events(case_id,event_type,actor_type,actor_uid,provider_label,public_detail,restricted_detail) VALUES ($1,'CASE_ESCALATED','ADMIN',$2,'Case escalated',$3::jsonb,$4::jsonb)`,[caseId,adminUid,JSON.stringify({state:'ESCALATED'}),JSON.stringify({destinationQueue,triggerCode})]);
    await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  audit(adminUid,caseId,'support_case_escalated',{destinationQueue,escalationType});
  emitSupportCaseUpdated(providerUid,caseId,'CASE_ESCALATED');
  return getAdminCase(caseId);
}

const NO_SOURCE_CHANGE_CODES=new Set(['GUIDANCE_PROVIDED','ISSUE_RESOLVED_NO_SOURCE_CHANGE','BOOKING_RECORD_CONFIRMED','REVIEW_RETAINED','SERVICE_RESTRICTION_MAINTAINED','SAFETY_CASE_TRANSFERRED','EXTERNAL_FOLLOW_UP_REQUIRED','UNABLE_TO_DETERMINE']);

export async function resolveCase(adminUid:string,caseId:string,input:Record<string,unknown>){
  const expectedVersion=validVersion(input.expectedVersion);
  const resolutionCode=String(input.resolutionCode??'').toUpperCase();
  if(!(RESOLUTION_CODES as readonly string[]).includes(resolutionCode)) throw fail('Invalid resolution code.','INVALID_RESOLUTION_CODE',422);
  if(!NO_SOURCE_CHANGE_CODES.has(resolutionCode)) throw fail('This resolution requires a committed source-system action. Use the canonical Booking, Finance, Review, Service, or Compliance workflow first.','SOURCE_ACTION_REQUIRED',409);
  const providerExplanation=safeText(input.providerExplanation,2000,'Provider-facing explanation');
  const internalExplanation=input.internalExplanation==null?null:String(input.internalExplanation).trim().slice(0,4000)||null;
  const clientRequestId=safeText(input.clientRequestId,128,'Client request id');
  const client=await pool.connect();let providerUid='';let appealEligible=false;
  try{
    await client.query('BEGIN');
    const replay=await client.query(`SELECT 1 FROM ${s}.support_case_resolutions WHERE case_id=$1 AND client_request_id=$2`,[caseId,clientRequestId]);
    if(replay.rowCount){await client.query('COMMIT');return getAdminCase(caseId);}
    const found=await client.query(`SELECT provider_uid,domain FROM ${s}.provider_support_cases WHERE case_id=$1 AND version=$2 AND internal_state NOT IN ('RESOLVED','CLOSED') FOR UPDATE`,[caseId,expectedVersion]);
    if(!found.rowCount) throw fail('Case changed or is already resolved.','CASE_VERSION_CONFLICT',409);
    providerUid=String(found.rows[0].provider_uid);
    appealEligible=['BOOKING_DISPUTE','FINANCE','REVIEWS','SERVICES','COMPLIANCE'].includes(String(found.rows[0].domain))&&Boolean(input.appealEligible);
    await client.query(`INSERT INTO ${s}.support_case_resolutions(case_id,resolution_code,provider_explanation,internal_explanation,source_actions,applied_by_uid,applied_by_role,appeal_eligible,client_request_id) VALUES ($1,$2,$3,$4,'[]'::jsonb,$5,'SUPPORT_OPERATIONS',$6,$7)`,[caseId,resolutionCode,providerExplanation,internalExplanation,adminUid,appealEligible,clientRequestId]);
    await client.query(`UPDATE ${s}.provider_support_cases SET provider_state='RESOLVED',internal_state='RESOLVED',provider_action_required=FALSE,servana_action_required=FALSE,resolution_code=$2,appeal_eligible=$3,appeal_deadline_at=CASE WHEN $3 THEN NOW()+INTERVAL '14 days' ELSE NULL END,resolved_at=NOW(),updated_at=NOW(),last_provider_visible_update_at=NOW(),version=version+1 WHERE case_id=$1`,[caseId,resolutionCode,appealEligible]);
    await client.query(`INSERT INTO ${s}.support_case_events(case_id,event_type,actor_type,actor_uid,provider_label,public_detail,restricted_detail,idempotency_key) VALUES ($1,'CASE_RESOLVED','ADMIN',$2,'Case resolved',$3::jsonb,$4::jsonb,$5)`,[caseId,adminUid,JSON.stringify({resolutionCode,explanation:providerExplanation,appealEligible}),JSON.stringify({internalExplanation}),`resolution:${clientRequestId}`]);
    await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  audit(adminUid,caseId,'support_case_resolved',{resolutionCode,appealEligible});
  emitSupportCaseUpdated(providerUid,caseId,'CASE_RESOLVED');
  void createNotification(providerUid,{notificationKey:`support-resolved:${caseId}`.slice(0,64),type:'SUPPORT_CASE_RESOLVED',severity:'info',title:'Support case resolved',safeBody:'A provider-visible resolution is available in Support Center.',safeContextLabel:'Support Center',route:{screen:'SupportCase',caseId},canOpenDetail:true}).catch(()=>undefined);
  return getAdminCase(caseId);
}

export async function decideAppeal(adminUid:string,caseId:string,appealId:string,input:Record<string,unknown>){
  const expectedVersion=validVersion(input.expectedVersion);const decision=String(input.decision??'').toUpperCase();
  if(!['UPHOLD','REOPEN_REVIEW'].includes(decision)) throw fail('Invalid appeal decision.','INVALID_APPEAL_DECISION',422);
  const reasonCode=safeText(input.providerReasonCode,64,'Provider reason code').toUpperCase().replace(/[^A-Z0-9_]/g,'_');
  const reasonDetail=safeText(input.providerReasonDetail,1500,'Provider explanation');
  const client=await pool.connect();let providerUid='';
  try{await client.query('BEGIN');
    const updated=await client.query(`UPDATE ${s}.support_case_appeals SET state=$4,provider_reason_code=$5,provider_reason_detail=$6,internal_notes=$7,decided_at=NOW(),version=version+1 WHERE appeal_id=$1 AND case_id=$2 AND version=$3 AND state IN ('SUBMITTED','UNDER_REVIEW') RETURNING provider_uid`,[appealId,caseId,expectedVersion,decision==='UPHOLD'?'ORIGINAL_DECISION_UPHELD':'UNDER_REVIEW',reasonCode,reasonDetail,input.internalNotes==null?null:String(input.internalNotes).trim().slice(0,4000)||null]);
    if(!updated.rowCount) throw fail('Appeal changed. Refresh before deciding.','APPEAL_VERSION_CONFLICT',409);providerUid=String(updated.rows[0].provider_uid);
    await client.query(`UPDATE ${s}.provider_support_cases SET provider_state=$2,internal_state=$3,servana_action_required=$4,updated_at=NOW(),last_provider_visible_update_at=NOW(),version=version+1 WHERE case_id=$1`,[caseId,decision==='UPHOLD'?'RESOLVED':'UNDER_REVIEW',decision==='UPHOLD'?'RESOLVED':'QUALITY_REVIEW',decision!=='UPHOLD']);
    await client.query(`INSERT INTO ${s}.support_case_events(case_id,event_type,actor_type,actor_uid,provider_label,public_detail,restricted_detail) VALUES ($1,'APPEAL_UPDATED','ADMIN',$2,'Appeal updated',$3::jsonb,$4::jsonb)`,[caseId,adminUid,JSON.stringify({decision,reasonCode,reasonDetail}),JSON.stringify({internalNotes:input.internalNotes??null})]);
    await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  audit(adminUid,caseId,'support_appeal_decided',{decision});emitSupportCaseUpdated(providerUid,caseId,'APPEAL_UPDATED');return getAdminCase(caseId);
}

export async function previewAdminAttachment(adminUid:string,caseId:string,attachmentId:string){
  const found=await dbQuery.query(`SELECT private_storage_path,safe_file_name,mime_type,evidence_class FROM ${s}.support_case_attachments WHERE attachment_id=$1 AND case_id=$2 AND state='AVAILABLE'`,[attachmentId,caseId]);
  if(!found.rowCount) throw fail('Evidence is unavailable.','EVIDENCE_NOT_FOUND',404);
  const {createPrivatePreviewUrl}=await import('../helpers/firebaseStorageUploader');
  const preview={attachmentId,fileName:found.rows[0].safe_file_name,mimeType:found.rows[0].mime_type,evidenceClass:found.rows[0].evidence_class,...(await createPrivatePreviewUrl(found.rows[0].private_storage_path,120))};
  audit(adminUid,caseId,'support_sensitive_evidence_previewed',{attachmentId,evidenceClass:found.rows[0].evidence_class});
  return preview;
}

export async function sweepBreachedCases(adminUid:string){
  const breached=await dbQuery.query(`UPDATE ${s}.provider_support_cases SET escalation_state='SLA_BREACHED',priority=CASE WHEN priority='NORMAL' THEN 'HIGH' ELSE priority END,updated_at=NOW(),version=version+1 WHERE escalation_due_at<NOW() AND internal_state NOT IN ('RESOLVED','CLOSED') AND escalation_state<>'SLA_BREACHED' RETURNING case_id,provider_uid`);
  for(const row of breached.rows){
    await dbQuery.query(`INSERT INTO ${s}.support_case_events(case_id,event_type,actor_type,actor_uid,provider_visible,provider_label,public_detail,restricted_detail) VALUES ($1,'SLA_BREACHED','SYSTEM',$2,TRUE,'Review target delayed',$3::jsonb,$4::jsonb)`,[row.case_id,adminUid,JSON.stringify({message:'This case is taking longer than its review target. Its priority has been preserved.'}),JSON.stringify({sweep:true})]);
    emitSupportCaseUpdated(String(row.provider_uid),String(row.case_id),'SLA_BREACHED');
  }
  return {processed:breached.rowCount??0};
}
