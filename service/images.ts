import sharp from 'sharp';
sharp.concurrency(1);
sharp.cache({memory:32,files:0,items:16});

export async function normalizeImage(input:Buffer):Promise<{bytes:Buffer;mimeType:string;width:number;height:number}> {
  if(input.length>5*1024*1024)throw new Error('Image too large');
  const decoder=sharp(input,{limitInputPixels:40_000_000,failOn:'warning',animated:false}).timeout({seconds:10});
  const metadata=await decoder.metadata();
  if(!metadata.format||!['jpeg','png','webp'].includes(metadata.format)||!metadata.width||!metadata.height||(metadata.pages??1)>1)throw new Error('Unsupported image');
  // Re-encoding verifies the pixel stream and removes location/EXIF metadata.
  let image=decoder.autoOrient().resize({width:4096,height:4096,fit:'inside',withoutEnlargement:true});
  image=metadata.format==='png'?image.png():metadata.format==='webp'?image.webp({quality:88}):image.jpeg({quality:88});
  const {data,info}=await image.toBuffer({resolveWithObject:true});
  if(data.length>5*1024*1024)throw new Error('Image too large');
  return {bytes:data,mimeType:`image/${metadata.format}`,width:info.width,height:info.height};
}
