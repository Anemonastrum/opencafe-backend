import { prisma } from '../configs/prisma.js';
import { parseCatalogId, parseCatalogQuery, validateProduct, withCatalogAdmin, catalogError, handleCatalogError } from '../utils/catalog.utils.js';
import { saveImage, removeImage } from '../utils/image.utils.js';

const include={category:{select:{id:true,name:true}}};
const lockCategory = async (tx,id) => {
  if (id === undefined || id === null) return;
  await tx.$queryRaw`SELECT id FROM categories WHERE id = ${id} FOR UPDATE`;
  if (!await tx.category.findUnique({where:{id}})) throw catalogError('Category not found',400);
};
export const listProducts = async (req,res) => {
  const {data,error}=parseCatalogQuery(req.query,true);
  if (error) return res.status(400).json({message:error});
  const {page,limit,where}=data;
  try {
    const [products,total]=await prisma.$transaction([prisma.product.findMany({where,include,orderBy:{id:'asc'},skip:(page-1)*limit,take:limit}),prisma.product.count({where})]);
    return res.json({products,total,page,limit});
  } catch(error) { return handleCatalogError(res,error); }
};
export const getProduct = async (req,res) => {
  const id=parseCatalogId(req.params.id);
  if (!id) return res.status(400).json({message:'Invalid product ID'});
  try {
    const product=await prisma.product.findUnique({where:{id},include});
    if (!product) return res.status(404).json({message:'Product not found'});
    return res.json(product);
  } catch(error) { return handleCatalogError(res,error); }
};
export const createProduct = async (req,res) => {
  const {data,error}=validateProduct(req.body);
  if (error) return res.status(400).json({message:error});
  let saved;
  try {
    const product=await withCatalogAdmin(req,async tx=>{
      await lockCategory(tx,data.categoryId);
      const created=await tx.product.create({data,include});
      if (!req.image) return created;
      saved=await saveImage(req.image,`product/${created.id}`);
      return tx.product.update({where:{id:created.id},data:{imageUrl:saved.url},include});
    });
    return res.status(201).json({message:'Product created successfully',product});
  } catch(error) { if (saved) await removeImage(saved.url); return handleCatalogError(res,error); }
};
export const updateProduct = async (req,res) => {
  const id=parseCatalogId(req.params.id);
  if (!id) return res.status(400).json({message:'Invalid product ID'});
  const {data,error}=validateProduct(req.body,true);
  if (error) return res.status(400).json({message:error});
  let saved,previous;
  try {
    const product=await withCatalogAdmin(req,async tx=>{
      await lockCategory(tx,data.categoryId);
      await tx.$queryRaw`SELECT id FROM products WHERE id = ${id} FOR UPDATE`;
      const current=await tx.product.findUnique({where:{id}});
      if (!current) throw catalogError('Product not found',404);
      previous=current.imageUrl;
      if (req.image) { saved=await saveImage(req.image,`product/${id}`); data.imageUrl=saved.url; }
      return tx.product.update({where:{id},data,include});
    });
    if (Object.hasOwn(data,'imageUrl')) await removeImage(previous);
    return res.json({message:'Product updated successfully',product});
  } catch(error) { if (saved) await removeImage(saved.url); return handleCatalogError(res,error); }
};
export const deleteProduct = async (req,res) => {
  const id=parseCatalogId(req.params.id);
  if (!id) return res.status(400).json({message:'Invalid product ID'});
  try {
    const product=await withCatalogAdmin(req,async tx=>{
      await tx.$queryRaw`SELECT id FROM products WHERE id = ${id} FOR UPDATE`;
      return tx.product.update({where:{id},data:{isAvailable:false},include});
    });
    return res.json({message:'Product marked unavailable',product});
  } catch(error) { return handleCatalogError(res,error); }
};
