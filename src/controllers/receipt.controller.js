import { withUserLock, validSession } from '../utils/session.utils.js';
import { parseCatalogId } from '../utils/catalog.utils.js';
import { ensureReceipt, paidReceipt, readReceipt, receiptPathname, receiptError } from '../utils/receipt.utils.js';

const authorize = (req, id) => withUserLock(req.user.id, async (tx, user) => {
  await tx.$queryRaw`SELECT id FROM orders WHERE id = ${id} FOR UPDATE`;
  const session = await tx.authSession.findUnique({where:{id:req.authSession}});
  if (!validSession(session,user) || !['ADMIN','CASHIER'].includes(user.role) || user.mustChangePassword) throw Object.assign(Error('Receipt permission required'),{status:403});
  const order = await tx.order.findUnique({where:{id},include:{items:{orderBy:{id:'asc'}},payments:true}});
  if (!order || (user.role !== 'ADMIN' && order.cashierId !== user.id)) throw receiptError(404);
  paidReceipt(order);
  return order;
});
const handleError = (res,error) => {
  const status=[403,404,409].includes(error.status)?error.status:503;
  return res.status(status).json({message:status===503?'Receipt unavailable; retry later':error.message});
};
export const generateReceipt = async (req,res) => {
  const id=parseCatalogId(req.params.id),hasBody=Number(req.headers['content-length'])>0||req.headers['transfer-encoding'];
  if (!id || Object.keys(req.query).length || (hasBody && (!req.is('application/json') || !req.body || Array.isArray(req.body) || typeof req.body!=='object' || Object.keys(req.body).length))) return res.status(400).json({message:'Invalid receipt request'});
  try {
    await authorize(req,id);
    const {created,...receipt}=await ensureReceipt(id);
    await authorize(req,id);
    return res.status(created?201:200).json({message:'Receipt ready',receipt});
  } catch(error){return handleError(res,error);}
};
export const downloadReceipt = async (req,res) => {
  const id=parseCatalogId(req.params.id);
  if (!id || Object.keys(req.query).length) return res.status(400).json({message:'Invalid receipt request'});
  try {
    const order=await authorize(req,id);
    if (!order.receiptUrl) throw receiptError(404);
    const pathname=receiptPathname(order.receiptUrl);
    if (!pathname) throw receiptError();
    const buffer=await readReceipt(pathname);
    await authorize(req,id);
    return res.set({'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Content-Disposition':`attachment; filename="${pathname.split('/').at(-1)}"`}).type('pdf').send(buffer);
  } catch(error){return handleError(res,error);}
};
