import { randomUUID } from 'node:crypto';
import type { Db } from '../db/pool';
import { AppError } from '../errors';
import { hashRequest } from '../idempotency';
import {
  CreateMediaUploadRequest, CompleteMediaUploadRequest, UploadPartsRequest,
  MediaLibraryQuery, UpdateMediaRequest, DeleteMediaRequest,
  type MediaUploadResponse,
} from '../schemas/capture-v2';
import { assertCaptureAuthority, captureMutation } from './policy';
import { CaptureQueue } from './queue';
import type { CaptureV2Context } from './types';

export const CAPTURE_PART_SIZE=8388608;
export interface UploadRecord {
  id:string;account_id:string;asset_id:string;installation_id:string|null;
  state:string;staging_key:string;provider_multipart_id:string|null;
  expected_bytes:number;expected_sha256:string;reserved_bytes:number;expires_at:Date;
  request_hash:string;error_code:string|null;part_receipts:{part_number:number;etag:string}[];
  generation:number;deleted_at:Date|null;source:string;kind:'photo'|'video';content_type:string;
}
export async function loadCaptureUpload(ctx:CaptureV2Context,tx:Db,id:string,lock=false):Promise<UploadRecord> {
  const {rows}=await tx.query(
    `SELECT u.*,m.generation,m.deleted_at,m.source,m.kind,m.content_type FROM upload_sessions u
     JOIN media_assets m ON m.account_id=u.account_id AND m.id=u.asset_id
     WHERE u.id=$1 AND u.account_id=$2${lock?' FOR UPDATE OF u,m':''}`,
    [id,ctx.authority.accountId],
  );
  const row=rows[0] as UploadRecord|undefined;
  if(!row || (ctx.authority.kind==='installation' && row.installation_id!==ctx.authority.installationId)) {
    throw new AppError('not_found');
  }
  return row;
}
export function mediaObjectPrefix(accountId:string,assetId:string,generation:number):string {
  return `accounts/${accountId}/media/${assetId}/${generation}`;
}
export class MediaIntake {
  readonly queue:CaptureQueue;
  constructor(private readonly ctx:CaptureV2Context) { this.queue=new CaptureQueue(ctx.db,ctx.now); }

  private async response(row:UploadRecord,sign=false):Promise<MediaUploadResponse> {
    const active=['created','uploading'].includes(row.state) && !row.deleted_at && row.expires_at>this.ctx.now();
    const partCount=Math.ceil(row.expected_bytes/CAPTURE_PART_SIZE);
    return {
      asset_id:row.asset_id,upload_id:row.id,state:row.state as MediaUploadResponse['state'],
      expires_at:row.expires_at.toISOString(),part_size:CAPTURE_PART_SIZE,part_count:partCount,
      parts:sign && active && row.provider_multipart_id
        ?await Promise.all(Array.from({length:Math.min(partCount,100)},(_,i)=>
          this.ctx.storage.signPart(row.staging_key,row.provider_multipart_id!,i+1,
            Math.min(900,Math.max(1,Math.floor((row.expires_at.getTime()-this.ctx.now().getTime())/1000)))))) : [],
      verified_parts:active && row.provider_multipart_id
        ?await this.ctx.storage.listParts(row.staging_key,row.provider_multipart_id):row.part_receipts,
      error_code:row.error_code,
    };
  }

  async createUpload(raw:unknown,key:string):Promise<MediaUploadResponse> {
    const input=CreateMediaUploadRequest.parse(raw);
    const ctx=this.ctx;
    return captureMutation(ctx,'create-upload',key,input,async tx=>{
      const fingerprint=hashRequest(input);
      const existing=await tx.query(
        `SELECT u.id,u.request_hash FROM media_assets m JOIN upload_sessions u
         ON u.asset_id=m.id AND u.account_id=m.account_id WHERE m.account_id=$1 AND m.client_capture_id=$2`,
        [ctx.authority.accountId,input.client_capture_id],
      );
      if(existing.rows[0]) {
        if(existing.rows[0].request_hash!==fingerprint) throw new AppError('idempotency_conflict');
        return this.response(await loadCaptureUpload(ctx,tx,existing.rows[0].id),true);
      }
      const max=input.kind==='photo'?ctx.limits.photoMaxBytes:ctx.limits.videoMaxBytes;
      if(input.byte_size>max) throw new AppError('payload_too_large',{message:'This file exceeds the media size limit.'});
      if((input.kind==='photo')!==input.content_type.startsWith('image/')) throw new AppError('invalid_input');
      if(input.source==='meta_glasses' && (!ctx.glassesEnabled || ctx.authority.kind!=='installation')) {
        throw new AppError('scope_denied',{message:'Experimental glasses capture is unavailable.'});
      }
      const installation=ctx.authority.kind==='installation'?ctx.authority.installationId:null;
      if(input.capture_session_id) {
        const r=await tx.query(
          `SELECT id FROM capture_sessions WHERE account_id=$1 AND id=$2 AND installation_id=$3
           AND source=$4 AND media_mode=$5 AND state='active'`,
          [ctx.authority.accountId,input.capture_session_id,installation,input.source,input.kind],
        );
        if(!r.rowCount) throw new AppError('not_found');
      }
      const reservation=input.byte_size+ctx.limits.derivativeAllowanceBytes;
      const usage=await tx.query<{used:number}>(
        `SELECT COALESCE(sum(amount),0) AS used FROM usage_reservations WHERE account_id=$1 AND state IN ('reserved','settled','unknown')`,
        [ctx.authority.accountId],
      );
      if(usage.rows[0]!.used+reservation>ctx.limits.accountQuotaBytes) {
        throw new AppError('quota_exceeded',{message:'Your account does not have enough available storage.'});
      }
      const assetId=randomUUID(),uploadId=randomUUID(),expires=new Date(ctx.now().getTime()+86400000);
      const staging=`accounts/${ctx.authority.accountId}/staging/${assetId}/${uploadId}`;
      await tx.query(
        `INSERT INTO media_assets(id,account_id,installation_id,client_capture_id,capture_session_id,kind,source,
          byte_size,sha256,content_type,captured_at,created_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [assetId,ctx.authority.accountId,installation,input.client_capture_id,input.capture_session_id??null,
          input.kind,input.source,input.byte_size,input.sha256,input.content_type,input.captured_at??null,ctx.now()],
      );
      const providerId=await ctx.storage.begin(staging,input.content_type);
      // A crash between begin and DB commit leaves only a staging multipart; bucket lifecycle bounds it.
      await tx.query(
        `INSERT INTO upload_sessions(id,account_id,asset_id,installation_id,authority_session_id,staging_key,
          provider_multipart_id,expected_bytes,expected_sha256,reserved_bytes,request_hash,expires_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [uploadId,ctx.authority.accountId,assetId,installation,ctx.authority.sessionId,staging,providerId,
          input.byte_size,input.sha256,reservation,fingerprint,expires],
      );
      await tx.query(
        `INSERT INTO usage_reservations(account_id,upload_id,amount,expires_at) VALUES($1,$2,$3,$4)`,
        [ctx.authority.accountId,uploadId,reservation,expires],
      );
      return this.response(await loadCaptureUpload(ctx,tx,uploadId),true);
    });
  }

  async getUpload(id:string):Promise<MediaUploadResponse> {
    await assertCaptureAuthority(this.ctx,this.ctx.db);
    return this.response(await loadCaptureUpload(this.ctx,this.ctx.db,id));
  }
  async parts(id:string,raw:unknown,key:string) {
    const input=UploadPartsRequest.parse(raw);
    return captureMutation(this.ctx,`parts:${id}`,key,input,async tx=>{
      const u=await loadCaptureUpload(this.ctx,tx,id,true);
      if(u.deleted_at || !['created','uploading'].includes(u.state) || u.expires_at<=this.ctx.now()) {
        throw new AppError('conflict',{message:'This upload is no longer active.'});
      }
      const partCount=Math.ceil(u.expected_bytes/CAPTURE_PART_SIZE);
      if(new Set(input.part_numbers).size!==input.part_numbers.length || input.part_numbers.some(n=>n>partCount)) {
        throw new AppError('invalid_input');
      }
      await tx.query(`UPDATE upload_sessions SET state='uploading' WHERE id=$1`,[id]);
      return {parts:await Promise.all(input.part_numbers.map(p=>this.ctx.storage.signPart(
        u.staging_key,u.provider_multipart_id!,p,Math.min(900,Math.floor((u.expires_at.getTime()-this.ctx.now().getTime())/1000)),
      )))};
    });
  }
  async completeUpload(id:string,raw:unknown,key:string):Promise<MediaUploadResponse> {
    const input=CompleteMediaUploadRequest.parse(raw);
    // Recheck tombstone even if an old completion response is in the idempotency store.
    await assertCaptureAuthority(this.ctx,this.ctx.db);
    const before=await loadCaptureUpload(this.ctx,this.ctx.db,id);
    if(before.deleted_at || ['aborted','expired','rejected'].includes(before.state)) throw new AppError('conflict');
    return captureMutation(this.ctx,`complete:${id}`,key,input,async tx=>{
      const u=await loadCaptureUpload(this.ctx,tx,id,true);
      if(u.deleted_at || ['aborted','expired','rejected'].includes(u.state) || (u.state!=='committed' && u.expires_at<=this.ctx.now())) {
        throw new AppError('conflict');
      }
      const count=Math.ceil(u.expected_bytes/CAPTURE_PART_SIZE);
      if(input.parts.length!==count || input.parts.some((p,i)=>p.part_number!==i+1)) throw new AppError('invalid_input');
      if(['committed','verifying'].includes(u.state)) {
        if(hashRequest(u.part_receipts)!==hashRequest(input.parts)) throw new AppError('idempotency_conflict');
        return this.response(u);
      }
      await tx.query(`UPDATE upload_sessions SET state='verifying',part_receipts=$2 WHERE id=$1`,[id,JSON.stringify(input.parts)]);
      await tx.query(`UPDATE media_assets SET status='verifying' WHERE account_id=$1 AND id=$2`,
        [u.account_id,u.asset_id]);
      await this.queue.enqueue(tx,{accountId:u.account_id,assetId:u.asset_id,uploadId:id,generation:u.generation,kind:'verify_upload'});
      return this.response({...u,state:'verifying',part_receipts:input.parts});
    });
  }
  async abortUpload(id:string,key:string) {
    return captureMutation(this.ctx,`abort:${id}`,key,{},async tx=>{
      const u=await loadCaptureUpload(this.ctx,tx,id,true);
      if(u.state==='committed') throw new AppError('conflict',{message:'Delete the media item to remove committed media.'});
      if(!['aborted','expired','rejected'].includes(u.state)) {
        await this.tombstone(tx,u.asset_id,u.generation);
        await tx.query(`UPDATE upload_sessions SET state='aborted' WHERE id=$1`,[id]);
      }
      return {upload_id:id,state:'aborted' as const};
    });
  }

  private async tombstone(tx:Db,id:string,generation:number):Promise<void> {
    const a=this.ctx.authority.accountId;
    await tx.query(
      `UPDATE media_assets SET status='deleted',deleted_at=$3,generation=generation+1,revision=revision+1
       WHERE account_id=$1 AND id=$2 AND deleted_at IS NULL`,[a,id,this.ctx.now()]);
    await tx.query(
      `UPDATE upload_sessions SET state='aborted' WHERE account_id=$1 AND asset_id=$2 AND state IN ('created','uploading','verifying')`,[a,id]);
    await tx.query(
      `UPDATE usage_reservations SET state='released' WHERE account_id=$1 AND upload_id IN
       (SELECT id FROM upload_sessions WHERE account_id=$1 AND asset_id=$2) AND state!='released'`,[a,id]);
    await tx.query(`UPDATE capture_work SET state='cancelled' WHERE account_id=$1 AND asset_id=$2 AND state IN ('queued','running')`,[a,id]);
    await this.queue.enqueue(tx,{accountId:a,assetId:id,generation:generation+1,kind:'purge_media'});
  }

  async deleteMedia(id:string,raw:unknown,key:string) {
    const input=DeleteMediaRequest.parse(raw);
    return captureMutation(this.ctx,`delete-media:${id}`,key,input,async tx=>{
      const {rows}=await tx.query(`SELECT generation,deleted_at FROM media_assets WHERE account_id=$1 AND id=$2 FOR UPDATE`,
        [this.ctx.authority.accountId,id]);
      const m=rows[0];
      if(!m) throw new AppError('not_found');
      if(!m.deleted_at && m.generation!==input.expected_generation) throw new AppError('conflict');
      if(!m.deleted_at) await this.tombstone(tx,id,m.generation);
      return {id,generation:m.deleted_at?m.generation:m.generation+1,status:'deleted' as const};
    });
  }

  async detail(id:string) {
    await assertCaptureAuthority(this.ctx,this.ctx.db);
    const {rows}=await this.ctx.db.query(`SELECT * FROM media_assets WHERE account_id=$1 AND id=$2 AND deleted_at IS NULL`,
      [this.ctx.authority.accountId,id]);
    if(!rows[0]) throw new AppError('not_found');
    const m=rows[0];
    const derivatives=await this.ctx.db.query(
      `SELECT d.*,s.timestamp_ms,s.extraction_version FROM media_derivatives d LEFT JOIN media_segments s
       ON s.account_id=d.account_id AND s.frame_derivative_id=d.id
       WHERE d.account_id=$1 AND d.asset_id=$2 AND d.generation=$3`,
      [m.account_id,id,m.generation],
    );
    const link=(variant:string)=>`/v2/media/${id}/content/${variant}`;
    const find=(kind:string)=>derivatives.rows.find(d=>d.kind===kind);
    return {
      media:{schema_version:1 as const,id,kind:m.kind as 'photo'|'video',source:m.source,status:m.status,
        analysis_status:m.analysis_status,created_at:m.created_at.toISOString(),title:m.title,
        ...(m.width?{width:m.width,height:m.height}:{}),
        ...(m.duration_ms?{duration_ms:m.duration_ms,audio_present:m.audio_present}:{}),
      },
      generation:m.generation,revision:m.revision,error_code:m.error_code,
      links:{
        original:m.original_key && ['processing','ready','failed'].includes(m.status)?link('original'):null,
        playback:find(m.kind==='photo'?'normalized':'playback')?link(find(m.kind==='photo'?'normalized':'playback')!.id):null,
        poster:find('poster')?link(find('poster')!.id):null,
        analysis:m.legacy_capture_id?`/captures/${m.legacy_capture_id}`:null,
      },
      frames:derivatives.rows.filter(d=>d.kind==='frame' && d.timestamp_ms!==null).map(d=>({
        id:d.id,timestamp_ms:d.timestamp_ms,extraction_version:d.extraction_version,thumbnail_url:link(d.id),
      })),
    };
  }

  async library(raw:unknown) {
    const input=MediaLibraryQuery.parse(raw);
    await assertCaptureAuthority(this.ctx,this.ctx.db);
    let cursor:{at:string;id:string}|null=null;
    if(input.cursor) {
      try { cursor=JSON.parse(Buffer.from(input.cursor,'base64url').toString()); }
      catch { throw new AppError('invalid_input'); }
      if(!cursor || typeof cursor.at!=='string' || typeof cursor.id!=='string' ||
        !/^[0-9a-f-]{36}$/i.test(cursor.id) || !Number.isFinite(Date.parse(cursor.at))) throw new AppError('invalid_input');
    }
    const {rows}=await this.ctx.db.query(
      `SELECT id,created_at FROM media_assets WHERE account_id=$1 AND deleted_at IS NULL
       AND ($2::text IS NULL OR kind=$2) AND ($3::text IS NULL OR status=$3) AND ($4::text IS NULL OR source=$4)
       AND ($5::timestamptz IS NULL OR (created_at,id)<($5,$6::uuid))
       ORDER BY created_at DESC,id DESC LIMIT $7`,
      [this.ctx.authority.accountId,input.kind??null,input.status??null,input.source??null,cursor?.at??null,cursor?.id??null,input.limit+1],
    );
    const selected=rows.slice(0,input.limit),last=selected.at(-1);
    return {items:await Promise.all(selected.map(r=>this.detail(r.id))),
      next_cursor:rows.length>input.limit && last?Buffer.from(JSON.stringify({at:last.created_at.toISOString(),id:last.id})).toString('base64url'):null};
  }
  async updateMedia(id:string,raw:unknown,key:string) {
    const input=UpdateMediaRequest.parse(raw);
    await captureMutation(this.ctx,`update-media:${id}`,key,input,async tx=>{
      const r=await tx.query(
        `UPDATE media_assets SET title=$3,revision=revision+1 WHERE account_id=$1 AND id=$2
         AND deleted_at IS NULL AND revision=$4 RETURNING id`,
        [this.ctx.authority.accountId,id,input.title,input.expected_revision]);
      if(!r.rowCount) {
        const existing=await tx.query(`SELECT id FROM media_assets WHERE account_id=$1 AND id=$2 AND deleted_at IS NULL`,[this.ctx.authority.accountId,id]);
        throw new AppError(existing.rowCount?'conflict':'not_found');
      }
      return {id};
    });
    return this.detail(id);
  }
  async content(id:string,variant:string) {
    await assertCaptureAuthority(this.ctx,this.ctx.db);
    const {rows}=await this.ctx.db.query(
      `SELECT m.original_key,d.object_key FROM media_assets m
       LEFT JOIN media_derivatives d ON d.account_id=m.account_id AND d.asset_id=m.id AND d.generation=m.generation AND d.id::text=$3
       WHERE m.account_id=$1 AND m.id=$2 AND m.deleted_at IS NULL AND m.status IN ('processing','ready','failed')`,
      [this.ctx.authority.accountId,id,variant]);
    const objectKey=variant==='original'?rows[0]?.original_key:rows[0]?.object_key;
    if(!objectKey) throw new AppError('not_found');
    return this.ctx.storage.read(objectKey);
  }
}
