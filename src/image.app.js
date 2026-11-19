import express from 'express';
import { imageConfig, imagePathPattern } from './utils/image.utils.js';
import { receiptPathname, readReceipt } from './utils/receipt.utils.js';

const imageApp = express();
imageApp.disable('x-powered-by');
imageApp.use(async (req, res) => {
  res.set('X-Content-Type-Options', 'nosniff');
  // Use raw path: never decode percent escapes into filesystem paths.
  const pathname = req.url.split('?')[0];
  if (['GET', 'HEAD'].includes(req.method) && receiptPathname(pathname)) {
    try {
      const buffer = await readReceipt(pathname);
      return res.set({ 'Cache-Control': 'private, no-store', 'Content-Disposition': `inline; filename="${pathname.split('/').at(-1)}"` }).type('pdf').send(buffer);
    } catch { return res.sendStatus(404); }
  }
  if (!['GET', 'HEAD'].includes(req.method) || !imagePathPattern.test(pathname)) return res.sendStatus(404);
  return res.type('webp').sendFile(pathname.slice('/uploads/'.length), { root: imageConfig.root, dotfiles: 'deny' }, error => {
    if (error && !res.headersSent) res.sendStatus(404);
    else if (error) res.destroy();
  });
});
export { imageApp };
