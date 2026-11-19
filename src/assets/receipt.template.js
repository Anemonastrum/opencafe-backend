import PDFDocument from 'pdfkit';
import { fileURLToPath } from 'node:url';
import { setImmediate } from 'node:timers/promises';
import { receiptQr, receiptError } from '../utils/receipt.utils.js';

const font = fileURLToPath(new URL('./NotoSans-Regular.ttf', import.meta.url));
const mm = 72 / 25.4;
const localTime = value => new Intl.DateTimeFormat('en-GB', {timeZone:'Asia/Jakarta',dateStyle:'short',timeStyle:'medium'}).format(new Date(value));

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
    const add = (value, align='left') => {
      fields.push({value,align});
    };
    const wrap = async ({value,align}) => {
      const clean=String(value).replace(/\r\n?/g,'\n').replace(/[^\S\n]+/g,' ').replace(/\n{3,}/g,'\n\n');
      let work=0;
      for(const paragraph of clean.split('\n')) {
        let line='',length=0;
        for(const character of paragraph) {
          const glyph = doc._font.font.hasGlyphForCodePoint(character.codePointAt(0)) ? character : '?';
          // ponytail: 64-code-point shaping ceiling; preserve remaining text on next line.
          if(line && (length>=64 || doc.widthOfString(line+glyph)>contentWidth)){rows.push({text:line,align});line='';length=0;}
          line+=glyph;length++;
          if(++work%128===0)await setImmediate();
          if(rows.length>12000)throw receiptError();
        }
        rows.push({text:line,align});
        if(rows.length>12000)throw receiptError();
      }
    };
    add(data.cafeName,'center');add(data.address,'center');add('--------------------------------');
    add(data.orderNumber);add(`Ordered: ${localTime(data.createdAt)}`);add(`Paid: ${localTime(data.payment.paidAt)} WIB`);add(`Cashier: ${data.cashierName}`);
    for(const item of data.items){add(item.productName);add(`${item.quantity} x IDR ${item.unitPrice}`);add(`IDR ${item.subtotal}`,'right');await setImmediate();}
    add('--------------------------------');
    const total=(label,value)=>{add(label);add(`IDR ${value}`,'right');};
    total('Subtotal',data.subtotal);
    total(`${data.taxName} ${data.taxRate}% (${data.taxInclusive?'included':'added'})`,data.taxAmount);
    total('Original total',data.total);total('Rounding',data.payment.roundingAdjustment);total('PAYABLE',data.payment.amount);
    add(`Method: ${data.payment.method}`);
    if(data.payment.method==='CASH'){total('Cash received',data.payment.cashReceived);total('Change',data.payment.changeAmount);}
    for(const field of fields)await wrap(field);
    const qr=receiptQr(receiptUrl), qrSize=(qr.size+8)*0.6*mm, footer=qrSize+30;
    const lineHeight=12,maxHeight=14000,maxRows=Math.floor((maxHeight-2*margin-footer)/lineHeight);
    const pages=Math.ceil(rows.length/maxRows);
    if(pages>16)throw receiptError();
    for(let page=0;page<pages;page++){
      const part=rows.slice(page*maxRows,(page+1)*maxRows),last=page===pages-1;
      const height=2*margin+part.length*lineHeight+(last?footer:0);
      doc.addPage({size:[width,height],margin:0});doc.font(font).fontSize(8);
      let y=margin;
      for(const row of part){doc.text(row.text,margin,y,{width:contentWidth,align:row.align,lineBreak:false});y+=lineHeight;}
      if(last){
        y+=4;const x=(width-qrSize)/2,cell=qrSize/(qr.size+8);
        doc.rect(x,y,qrSize,qrSize).fill('white');
        doc.fillColor('black');
        for(let r=0;r<qr.size;r++)for(let c=0;c<qr.size;c++)if(qr.get(r,c))doc.rect(x+(c+4)*cell,y+(r+4)*cell,cell,cell).fill();
        doc.link(x,y,qrSize,qrSize,receiptUrl);
        doc.text('Scan to download receipt',margin,y+qrSize+5,{width:contentWidth,align:'center',lineBreak:false});
      }
      await setImmediate();
    }
    doc.end();return await done;
  } catch(error){doc.destroy();throw receiptError();}
};
