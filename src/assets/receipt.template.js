import PDFDocument from 'pdfkit';
import { fileURLToPath } from 'node:url';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import sharp from 'sharp';
import { imageConfig } from '../utils/image.utils.js';
import { setImmediate } from 'node:timers/promises';
import { receiptQr, receiptError } from '../utils/receipt.utils.js';

const font = fileURLToPath(new URL('./NotoSans-Regular.ttf', import.meta.url));
const boldFont = fileURLToPath(new URL('./NotoSans-Bold.ttf', import.meta.url));
const mm = 72 / 25.4;
const localTime = value => new Intl.DateTimeFormat('en-GB', {timeZone:'Asia/Jakarta',dateStyle:'short',timeStyle:'medium'}).format(new Date(value));

// Read only installation-owned cafe uploads; stale/missing logos must not block receipts.
const receiptLogo = async url => {
  if (typeof url !== 'string' || !url.startsWith(imageConfig.base+'/uploads/cafe/')) return;
  const name=url.slice((imageConfig.base+'/uploads/cafe/').length);
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.webp$/.test(name)) return;
  let file;
  try {
    for (const dir of [imageConfig.root,imageConfig.root+'/cafe']) {
      const stat=await lstat(dir);if(!stat.isDirectory() || stat.isSymbolicLink())return;
    }
    file=await open(imageConfig.root+'/cafe/'+name,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    const stat=await file.stat();if(!stat.isFile() || stat.size>5*1024*1024)return;
    return await sharp(await file.readFile(),{limitInputPixels:16000000}).resize({width:256,height:128,fit:'inside',withoutEnlargement:true}).png().toBuffer();
  } catch { return; }
  finally { await file?.close(); }
};

export const renderReceipt = async (data, paperSize, receiptUrl) => {
  if (!['58mm','80mm'].includes(paperSize)) throw receiptError();
  const width = Number(paperSize.slice(0,2))*mm, margin = 4*mm, contentWidth = width-2*margin;
  const doc = new PDFDocument({autoFirstPage:false,compress:true,info:{Title:'Receipt',Creator:'OpenCafe'}});
  const chunks=[]; let bytes=0;
  const done = new Promise((resolve,reject)=>{
    doc.on('data',chunk=>{bytes+=chunk.length;if(bytes>8*1024*1024)doc.destroy(receiptError());else chunks.push(chunk);});
    doc.on('error',reject);doc.on('end',()=>resolve(Buffer.concat(chunks)));
  });
  // Attach rejection immediately while layout yields to the event loop.
  done.catch(()=>{});
  try {
    doc.font(font).fontSize(8);
    const rows=[], fields=[];
    const add = (value, align='left') => fields.push({value,align});
    const pair = (label,value) => fields.push({label,value});
    const wrap = async (value,available) => {
      const lines=[];
      const clean=String(value).replace(/\r\n?/g,'\n').replace(/[^\S\n]+/g,' ').replace(/\n{3,}/g,'\n\n');
      let work=0;
      for(const paragraph of clean.split('\n')) {
        let line='',length=0;
        for(const character of paragraph) {
          const glyph = doc._font.font.hasGlyphForCodePoint(character.codePointAt(0)) ? character : '?';
          // ponytail: 64-code-point shaping ceiling; preserve remaining text on next line.
          if(line && (length>=64 || doc.widthOfString(line+glyph)>available)){lines.push(line);line='';length=0;}
          line+=glyph;length++;
          if(++work%128===0)await setImmediate();
          if(lines.length>12000)throw receiptError();
        }
        lines.push(line);
        if(lines.length>12000)throw receiptError();
      }
      return lines;
    };
    const logo=await receiptLogo(data.logoUrl);
    fields.push({value:data.cafeName,align:'center',heading:true});add(data.address,'center');fields.push({separator:true});
    pair('Ordered',localTime(data.createdAt));pair('Paid',`${localTime(data.payment.paidAt)} WIB`);pair('Cashier',data.cashierName);
    fields.push({separator:true});
    for(const item of data.items){add(item.productName);pair(`${item.quantity} x IDR ${item.unitPrice}`,`IDR ${item.subtotal}`);await setImmediate();}
    fields.push({separator:true});
    const total=(label,value)=>pair(label,`IDR ${value}`);
    total('Subtotal',data.subtotal);
    total(`${data.taxName} ${data.taxRate}% (${data.taxInclusive?'included':'added'})`,data.taxAmount);
    total('Total',data.payment.amount);
    pair('Method',data.payment.method);
    if(data.payment.method==='CASH'){total('Cash received',data.payment.cashReceived);total('Change',data.payment.changeAmount);}
    for(const field of fields) {
      doc.font(field.heading?boldFont:font).fontSize(field.heading?10:8);
      if(field.separator)rows.push({separator:true});
      else if(field.label===undefined)for(const text of await wrap(field.value,contentWidth))rows.push({text,align:field.align,heading:field.heading});
      else {
        const leftWidth=Math.min(doc.widthOfString(field.label),contentWidth-Math.min(doc.widthOfString(field.value),contentWidth*0.7)-6),rightWidth=contentWidth-leftWidth-6;
        const left=await wrap(field.label,leftWidth),right=await wrap(field.value,rightWidth);
        for(let i=0;i<Math.max(left.length,right.length);i++)rows.push({text:left[i]||'',right:right[i]||'',leftWidth,rightWidth});
      }
      if(rows.length>12000)throw receiptError();
    }
    const qr=receiptQr(receiptUrl), qrSize=(qr.size+8)*0.6*mm, footer=qrSize+8;
    const lineHeight=12,maxHeight=14000,headingExtra=rows.filter(row=>row.heading).length*4;
    const maxRows=Math.floor((maxHeight-2*margin-footer-(logo?46:0)-headingExtra)/lineHeight);
    const pages=Math.ceil(rows.length/maxRows);
    if(pages>16)throw receiptError();
    for(let page=0;page<pages;page++){
      const part=rows.slice(page*maxRows,(page+1)*maxRows),last=page===pages-1;
      const logoHeight=page===0&&logo?46:0;
      const height=2*margin+logoHeight+part.reduce((height,row)=>height+(row.heading?16:lineHeight),0)+(last?footer:0);
      doc.addPage({size:[width,height],margin:0});doc.font(font).fontSize(8);
      let y=margin;
      if(logoHeight){doc.image(logo,(width-64)/2,y,{fit:[64,40],align:'center',valign:'center'});y+=logoHeight;}
      for(const row of part){
        if(row.separator){doc.save().lineWidth(0.5).moveTo(margin,y+6).lineTo(width-margin,y+6).stroke().restore();y+=lineHeight;continue;}
        doc.font(row.heading?boldFont:font).fontSize(row.heading?10:8);
        doc.text(row.text,margin,y,{width:row.leftWidth??contentWidth,align:row.align||'left',lineBreak:false});
        if(row.right)doc.text(row.right,width-margin-row.rightWidth,y,{width:row.rightWidth,align:'right',lineBreak:false});
        y+=row.heading?16:lineHeight;
      }
      if(last){
        y+=4;const x=(width-qrSize)/2,cell=qrSize/(qr.size+8);
        doc.rect(x,y,qrSize,qrSize).fill('white');
        doc.fillColor('black');
        for(let r=0;r<qr.size;r++)for(let c=0;c<qr.size;c++)if(qr.get(r,c))doc.rect(x+(c+4)*cell,y+(r+4)*cell,cell,cell).fill();
        doc.link(x,y,qrSize,qrSize,receiptUrl);
      }
      await setImmediate();
    }
    doc.end();return await done;
  } catch(error){doc.destroy();throw receiptError();}
};
