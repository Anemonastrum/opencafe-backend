import { withUserLock, validSession } from './session.utils.js';

export const parseCatalogId = value => typeof value === 'string' && /^[1-9]\d{0,9}$/.test(value) && Number(value) <= 2147483647 ? Number(value) : null;
const text = (value, max) => typeof value === 'string' && value.isWellFormed() && value.trim() && [...value.trim()].length <= max;
const validate = (body, product, update) => {
  const fields = product ? ['name','price','description','imageUrl','categoryId','isAvailable'] : ['name'];
  if (!body || typeof body !== 'object' || Array.isArray(body) || !Object.keys(body).length || Object.keys(body).some(key => !fields.includes(key))) return { error: 'Invalid catalog fields' };
  if (!update && (body.name === undefined || (product && body.price === undefined))) return { error: 'Name and product price are required' };
  const data = {};
  for (const [key,value] of Object.entries(body)) {
    if (key === 'name') { if (!text(value,product ? 150 : 100)) return { error: 'Invalid name' }; data.name=value.trim(); }
    if (key === 'price') {
      if (!['number','string'].includes(typeof value) || !/^\d{1,10}(\.\d{1,2})?$/.test(String(value))) return { error: 'Price must be 0–9999999999.99 with at most two decimals' };
      data.price=String(value);
    }
    if (key === 'description') { if (value !== null && (!text(value,65535) || Buffer.byteLength(value.trim())>65535)) return { error: 'Invalid description' }; data.description=value === null ? null : value.trim(); }
    if (key === 'imageUrl') { if (value !== null) return { error: 'Upload an image instead of supplying imageUrl' }; data.imageUrl=null; }
    if (key === 'isAvailable') { if (typeof value !== 'boolean') return { error: 'isAvailable must be boolean' }; data.isAvailable=value; }
    if (key === 'categoryId') {
      const id = typeof value === 'number' && Number.isInteger(value) ? parseCatalogId(String(value)) : parseCatalogId(value);
      if (value !== null && !id) return { error: 'Invalid categoryId' }; data.categoryId=value === null ? null : id;
    }
  }
  return { data };
};
export const validateCategory = (body, update=false) => validate(body,false,update);
export const validateProduct = (body, update=false) => validate(body,true,update);
export const parseCatalogQuery = (query, products=false) => {
  const fields=['page','limit','search',...(products ? ['categoryId','isAvailable'] : [])];
  if (Object.keys(query).some(key=>!fields.includes(key))) return { error:'Invalid query fields' };
  const page=query.page === undefined ? 1 : parseCatalogId(query.page), limit=query.limit === undefined ? 20 : parseCatalogId(query.limit);
  if (!page || !limit || limit>100 || (page-1)*limit>2147483647) return { error:'Invalid page or limit' };
  const where={};
  if (query.search !== undefined) { if (!text(query.search,150)) return { error:'Invalid search' }; where.name={contains:query.search.trim()}; }
  if (query.categoryId !== undefined) { const id=parseCatalogId(query.categoryId); if (!id) return { error:'Invalid categoryId' }; where.categoryId=id; }
  if (query.isAvailable !== undefined) { if (!['true','false'].includes(query.isAvailable)) return { error:'Invalid isAvailable' }; where.isAvailable=query.isAvailable==='true'; }
  return { data:{page,limit,where} };
};
export const catalogError = (message,status) => Object.assign(new Error(message),{status});
export const withCatalogAdmin = (req,callback) => withUserLock(req.user.id,async (tx,user) => {
  const session=await tx.authSession.findUnique({where:{id:req.authSession}});
  if (!validSession(session,user) || user.role!=='ADMIN' || user.mustChangePassword) throw catalogError('Administrator permission required',403);
  return callback(tx);
});
export const handleCatalogError = (res,error) => {
  if ([400,403,404,409].includes(error.status)) return res.status(error.status).json({message:error.message});
  const mapped={P2002:[409,'Category name already exists'],P2025:[404,'Catalog record not found'],P2003:[409,'Catalog reference conflict'],P2034:[409,'Catalog changed concurrently; retry request']};
  const [status,message]=mapped[error.code] || [500,'Server error'];
  return res.status(status).json({message});
};
