import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile, stat, readdir, unlink, copyFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { MultipartPart, MultipartStorage } from './multipart-types';
import { isSafeObjectKey } from './signing';

/** Filesystem test double only. Durable bytes and multipart receipts, same boundary as S3. */
export class LocalMultipartStorage implements MultipartStorage {
  constructor(private readonly root: string, private readonly baseUrl: string, private readonly secret: string) {}
  private object(key: string): string {
    if (!isSafeObjectKey(key)) throw new Error('Invalid object key');
    return join(this.root,'objects',key);
  }
  private upload(id: string): string {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid upload');
    return join(this.root,'multipart',id);
  }
  private async metadata(id: string): Promise<{key:string;contentType:string;closed:boolean}> {
    return JSON.parse(await readFile(join(this.upload(id),'metadata.json'),'utf8'));
  }
  async begin(key: string, contentType: string): Promise<string> {
    this.object(key);
    const id=randomUUID();
    await mkdir(this.upload(id),{recursive:true,mode:0o700});
    await writeFile(join(this.upload(id),'metadata.json'),JSON.stringify({key,contentType,closed:false}),{mode:0o600});
    return id;
  }
  async signPart(key: string, id: string, part: number, expiresInSeconds: number) {
    const m=await this.metadata(id);
    if(m.key!==key || m.closed) throw new Error('Upload closed');
    const expires=Math.floor(Date.now()/1000)+Math.min(900,expiresInSeconds);
    const signature=createHmac('sha256',this.secret).update(`${id}:${part}:${expires}`).digest('hex');
    return {part_number:part,method:'PUT' as const,
      url:`${this.baseUrl}/v2/storage/parts/${id}/${part}?expires=${expires}&signature=${signature}`,
      headers:{},expires_at:new Date(expires*1000).toISOString()};
  }
  async acceptSignedPart(id: string, part: number, expires: number, signature: string, body: AsyncIterable<Uint8Array>): Promise<string> {
    const expected=Buffer.from(createHmac('sha256',this.secret).update(`${id}:${part}:${expires}`).digest('hex'));
    const got=Buffer.from(signature);
    if(!Number.isInteger(expires) || expires<=Date.now()/1000 || expires>Date.now()/1000+901 ||
      expected.length!==got.length || !timingSafeEqual(expected,got)) throw new Error('Part authorization expired');
    return this.writePart(id,part,body);
  }
  /** Test helper models provider PUT. Production callers use signed instructions. */
  async writePart(id: string, part: number, body: AsyncIterable<Uint8Array>): Promise<string> {
    if(!Number.isInteger(part)||part<1||part>10000) throw new Error('Invalid part');
    const m=await this.metadata(id);
    if(m.closed) throw new Error('Upload closed');
    let size=0;
    const hash=createHash('sha256'), temp=join(this.upload(id),`${part}.${randomUUID()}.tmp`);
    async function* bounded() {
      for await(const chunk of body) {
        size+=chunk.byteLength;
        if(size>8388608) throw new Error('Part too large');
        hash.update(chunk); yield chunk;
      }
    }
    try {
      await pipeline(Readable.from(bounded()),createWriteStream(temp,{mode:0o600,flags:'wx'}));
      // A late PUT can only affect staging, never an immutable committed object.
      if((await this.metadata(id)).closed) throw new Error('Upload closed');
      await copyFile(temp,join(this.upload(id),`${part}.part`));
      return `"${hash.digest('hex')}"`;
    } finally { await unlink(temp).catch(()=>undefined); }
  }
  async listParts(key: string,id: string): Promise<MultipartPart[]> {
    const m=await this.metadata(id);
    if(m.key!==key) throw new Error('Upload mismatch');
    const files=await readdir(this.upload(id)), parts:MultipartPart[]=[];
    for(const name of files.filter(n=>/^\d+\.part$/.test(n))) {
      const hash=createHash('sha256');
      for await(const chunk of createReadStream(join(this.upload(id),name))) hash.update(chunk);
      parts.push({part_number:Number(name.split('.')[0]),etag:`"${hash.digest('hex')}"`});
    }
    return parts.sort((a,b)=>a.part_number-b.part_number);
  }
  async finish(key: string,id: string,parts: MultipartPart[]): Promise<void> {
    const m=await this.metadata(id);
    if(m.key!==key) throw new Error('Upload mismatch');
    if(m.closed) { await stat(this.object(key)); return; }
    const found=await this.listParts(key,id);
    if(JSON.stringify(found)!==JSON.stringify(parts)) throw new Error('Invalid part receipts');
    const self=this;
    async function* joined() {
      for(const part of parts) yield* createReadStream(join(self.upload(id),`${part.part_number}.part`));
    }
    await this.put(key,joined(),m.contentType,0);
    await writeFile(join(this.upload(id),'metadata.json'),JSON.stringify({...m,closed:true}));
  }
  async abort(key: string,id: string): Promise<void> {
    const m=await this.metadata(id);
    if(m.key!==key) throw new Error('Upload mismatch');
    await writeFile(join(this.upload(id),'metadata.json'),JSON.stringify({...m,closed:true}));
    for(const f of await readdir(this.upload(id))) {
      if(/^\d+\.part$/.test(f)) await unlink(join(this.upload(id),f));
    }
  }
  async read(key: string) {
    const path=this.object(key);
    const metadata=JSON.parse(await readFile(`${path}.json`,'utf8')) as {contentType:string};
    return {body:createReadStream(path),byteSize:(await stat(path)).size,contentType:metadata.contentType};
  }
  async seal(stagingKey: string,immutableKey: string): Promise<void> {
    const from=this.object(stagingKey),to=this.object(immutableKey);
    await mkdir(dirname(to),{recursive:true,mode:0o700});
    await copyFile(from,to);
    await copyFile(`${from}.json`,`${to}.json`);
  }
  async put(key: string,body: AsyncIterable<Uint8Array>,contentType: string,_byteSize: number): Promise<void> {
    const path=this.object(key);
    await mkdir(dirname(path),{recursive:true,mode:0o700});
    await pipeline(Readable.from(body),createWriteStream(path,{mode:0o600}));
    await writeFile(`${path}.json`,JSON.stringify({contentType}),{mode:0o600});
  }
  async delete(key: string): Promise<void> {
    const path=this.object(key);
    await unlink(path).catch(e=>{if(e.code!=='ENOENT') throw e;});
    await unlink(`${path}.json`).catch(e=>{if(e.code!=='ENOENT') throw e;});
  }
}
