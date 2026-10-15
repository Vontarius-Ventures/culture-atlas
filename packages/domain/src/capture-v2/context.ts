import sharp from 'sharp';
import { AppError } from '../errors';
import { DEFAULT_CAPTURE_LIMITS, type CaptureV2Context, type MediaVerifier } from './types';

/** Photo-only default: video requires P2's resource-bounded qualified probe. */
export const photoMediaVerifier: MediaVerifier = {
  async verify(input) {
    if(input.kind!=='photo') throw new AppError('invalid_input',{message:'Video preparation is unavailable. Try again later.'});
    const chunks: Uint8Array[]=[];
    let bytes=0;
    for await(const chunk of input.body) {
      bytes+=chunk.byteLength;
      if(bytes>input.limits.photoMaxBytes) throw new AppError('payload_too_large');
      chunks.push(chunk);
    }
    try {
      const photo=sharp(Buffer.concat(chunks),{limitInputPixels:input.limits.photoMaxPixels,failOn:'warning',animated:false});
      const metadata=await photo.metadata();
      const types:Record<string,string>={jpeg:'image/jpeg',png:'image/png',webp:'image/webp'};
      if(!metadata.format || types[metadata.format]!==input.contentType || !metadata.width || !metadata.height ||
        (metadata.pages??1)>1) throw new Error('Unsupported photo');
      // Metadata alone is not decode validation.
      await photo.rotate().resize({width:2048,height:2048,fit:'inside',withoutEnlargement:true}).jpeg().toBuffer();
      return {contentType:input.contentType,width:metadata.width,height:metadata.height};
    } catch {
      throw new AppError('unsupported_image',{message:'This photo could not be decoded. Use a valid JPEG, PNG or WebP.'});
    }
  },
};

export function createCaptureV2Context(
  input: Pick<CaptureV2Context,'authority'|'db'|'storage'> & Partial<Omit<CaptureV2Context,'authority'|'db'|'storage'>>,
): CaptureV2Context {
  return {...input,now:input.now??(()=>new Date()),limits:input.limits??DEFAULT_CAPTURE_LIMITS,
    verifier:input.verifier??photoMediaVerifier,glassesEnabled:input.glassesEnabled??false};
}
