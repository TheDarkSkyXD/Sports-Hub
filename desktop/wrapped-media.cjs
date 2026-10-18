const {crc32,gunzip}=require('node:zlib');
const {promisify}=require('node:util');
const path=require('node:path');
const unzip=promisify(gunzip);
const MAX_INPUT_BYTES=16*1024*1024;
const MAX_OUTPUT_BYTES=32*1024*1024;
const MAX_PIXEL_BYTES=16*1024*1024;
const PNG=Buffer.from([137,80,78,71,13,10,26,10]);
const PIXELS=Buffer.from('TIKTIKPX'),RAW=Buffer.from('TIKTIKRAW'),GZIP=Buffer.from('TIKTIKTSGZ');
let sharp;
function pngDecoder(){
  if(!sharp){
    try{sharp=require('sharp');}
    catch(error){if(error.code!=='MODULE_NOT_FOUND'||!process.resourcesPath)throw error;sharp=require(path.join(process.resourcesPath,'server','node_modules','sharp'));}
  }
  return sharp;
}
function isWrappedMediaPrefix(bytes){
  return bytes.subarray(0,8).equals(PNG)||bytes.subarray(0,8).equals(PIXELS)||
    bytes.subarray(0,RAW.length).equals(RAW)||bytes.subarray(0,GZIP.length).equals(GZIP)||
    bytes[0]===0x1f&&bytes[1]===0x8b||bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP';
}
function transportStream(bytes){
  if(bytes.length<3*188||bytes.length>MAX_OUTPUT_BYTES||bytes.length%188)throw new Error('Invalid wrapped MPEG-TS length');
  for(let offset=0;offset<bytes.length;offset+=188)if(bytes[offset]!==0x47)throw new Error('Invalid wrapped MPEG-TS sync');
  return bytes;
}
async function payload(bytes,signal,insideWrapper=false){
  signal.throwIfAborted();
  if(insideWrapper){
    const rawOffset=bytes.indexOf(RAW),gzipOffset=bytes.indexOf(GZIP);
    if(rawOffset>=0)bytes=bytes.subarray(rawOffset);
    else if(gzipOffset>=0)bytes=bytes.subarray(gzipOffset);
    else if(bytes[0]!==0x1f||bytes[1]!==0x8b){
      let start=bytes.length;
      for(let offset=bytes.length-188;offset>=0&&bytes[offset]===0x47;offset-=188)start=offset;
      return transportStream(bytes.subarray(start));
    }
  }
  if(bytes.subarray(0,RAW.length).equals(RAW))return transportStream(bytes.subarray(RAW.length));
  const gzip=bytes.subarray(0,GZIP.length).equals(GZIP)?bytes.subarray(GZIP.length):bytes;
  if(gzip[0]===0x1f&&gzip[1]===0x8b){const result=await unzip(gzip,{maxOutputLength:MAX_OUTPUT_BYTES});signal.throwIfAborted();return transportStream(result);}
  return transportStream(bytes);
}
function pngStructure(bytes){
  let offset=8,width=0,height=0,idat=false;
  for(let count=0;count<8192&&offset+12<=bytes.length;count++){
    const size=bytes.readUInt32BE(offset);
    if(size>bytes.length-offset-12)throw new Error('Invalid wrapped PNG chunk');
    const type=bytes.toString('ascii',offset+4,offset+8),start=offset+8;
    if(crc32(bytes.subarray(offset+4,start+size))!==bytes.readUInt32BE(start+size))throw new Error('Invalid wrapped PNG checksum');
    if(count===0){
      if(type!=='IHDR'||size!==13)throw new Error('Invalid wrapped PNG header');
      width=bytes.readUInt32BE(start);height=bytes.readUInt32BE(start+4);
      if(!width||!height||width>16384||height>16384||width*height*3>MAX_PIXEL_BYTES||bytes[start+8]!==8||
        ![2,6].includes(bytes[start+9])||bytes[start+10]||bytes[start+11]||bytes[start+12])throw new Error('Unsupported wrapped PNG pixels');
    }else if(type==='IHDR')throw new Error('Duplicate wrapped PNG header');
    if(type==='IDAT')idat=true;
    offset+=size+12;
    if(type==='IEND'){if(size||!idat)throw new Error('Invalid wrapped PNG end');return {width,height,end:offset};}
    if(/^[A-Z]/.test(type)&&!['IHDR','IDAT'].includes(type))throw new Error('Unsupported wrapped PNG chunk');
  }
  throw new Error('Unfinished wrapped PNG');
}
async function decodeWrappedMedia(bytes,signal){
  signal.throwIfAborted();
  if(bytes.length>MAX_INPUT_BYTES)throw new Error('Wrapped media input exceeds limit');
  if(bytes.subarray(0,8).equals(PNG)){
    const {width,height,end}=pngStructure(bytes);
    if(end<bytes.length)return await payload(bytes.subarray(end),signal,true);
    const {data,info}=await pngDecoder()(bytes,{failOn:'warning',limitInputPixels:Math.floor(MAX_PIXEL_BYTES/3)}).timeout({seconds:2}).removeAlpha().raw().toBuffer({resolveWithObject:true});
    signal.throwIfAborted();
    if(info.width!==width||info.height!==height||info.channels!==3||data.length!==width*height*3||
      data.length<14||!data.subarray(0,8).equals(PIXELS))throw new Error('Invalid wrapped pixel marker');
    const length=data.readUInt32BE(8);
    if(length<2||length>MAX_INPUT_BYTES||length>data.length-12||data[12]!==0x1f||data[13]!==0x8b)throw new Error('Invalid wrapped pixel payload');
    return await payload(data.subarray(12,12+length),signal);
  }
  if(bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP'){
    if(bytes.length<20||bytes.readUInt32LE(4)+8!==bytes.length)throw new Error('Invalid wrapped WebP length');
    let offset=12;
    for(let count=0;count<8192&&offset+8<=bytes.length;count++){
      const type=bytes.toString('ascii',offset,offset+4),length=bytes.readUInt32LE(offset+4);offset+=8;
      if(length>bytes.length-offset)throw new Error('Invalid wrapped WebP chunk');
      if(type==='EXIF')return await payload(bytes.subarray(offset,offset+length),signal,true);
      offset+=length+(length&1);
    }
    throw new Error('Wrapped WebP payload missing');
  }
  if(isWrappedMediaPrefix(bytes))return await payload(bytes,signal);
  return bytes;
}
module.exports={decodeWrappedMedia,isWrappedMediaPrefix,MAX_INPUT_BYTES};
