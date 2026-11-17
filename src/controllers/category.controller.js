import { prisma } from '../configs/prisma.js';
import { parseCatalogId, parseCatalogQuery, validateCategory, withCatalogAdmin, catalogError, handleCatalogError } from '../utils/catalog.utils.js';

export const listCategories = async (req,res) => {
  const {data,error}=parseCatalogQuery(req.query);
  if (error) return res.status(400).json({message:error});
  const {page,limit,where}=data;
  try {
    const [categories,total]=await prisma.$transaction([prisma.category.findMany({where,orderBy:{id:'asc'},skip:(page-1)*limit,take:limit}),prisma.category.count({where})]);
    return res.json({categories,total,page,limit});
  } catch(error) { return handleCatalogError(res,error); }
};
export const getCategory = async (req,res) => {
  const id=parseCatalogId(req.params.id);
  if (!id) return res.status(400).json({message:'Invalid category ID'});
  try {
    const category=await prisma.category.findUnique({where:{id}});
    if (!category) return res.status(404).json({message:'Category not found'});
    return res.json(category);
  } catch(error) { return handleCatalogError(res,error); }
};
export const createCategory = async (req,res) => {
  const {data,error}=validateCategory(req.body);
  if (error) return res.status(400).json({message:error});
  try {
    const category=await withCatalogAdmin(req,tx=>tx.category.create({data}));
    return res.status(201).json({message:'Category created successfully',category});
  } catch(error) { return handleCatalogError(res,error); }
};
export const updateCategory = async (req,res) => {
  const id=parseCatalogId(req.params.id);
  if (!id) return res.status(400).json({message:'Invalid category ID'});
  const {data,error}=validateCategory(req.body,true);
  if (error) return res.status(400).json({message:error});
  try {
    const category=await withCatalogAdmin(req,async tx=>{
      await tx.$queryRaw`SELECT id FROM categories WHERE id = ${id} FOR UPDATE`;
      return tx.category.update({where:{id},data});
    });
    return res.json({message:'Category updated successfully',category});
  } catch(error) { return handleCatalogError(res,error); }
};
export const deleteCategory = async (req,res) => {
  const id=parseCatalogId(req.params.id);
  if (!id) return res.status(400).json({message:'Invalid category ID'});
  try {
    await withCatalogAdmin(req,async tx=>{
      await tx.$queryRaw`SELECT id FROM categories WHERE id = ${id} FOR UPDATE`;
      if (!await tx.category.findUnique({where:{id}})) throw catalogError('Category not found',404);
      if (await tx.product.count({where:{categoryId:id}})) throw catalogError('Category is still used by products',409);
      await tx.category.delete({where:{id}});
    });
    return res.json({message:'Category deleted successfully'});
  } catch(error) { return handleCatalogError(res,error); }
};
