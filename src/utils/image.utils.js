import 'dotenv/config';
import sharp from 'sharp';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, rename, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { crc32 } from 'node:zlib';

const base = process.env.IMAGE_BASE_URL || 'http://localhost:3001';
const origin = new URL(base);
if (!['http:', 'https:'].includes(origin.protocol) || origin.origin !== base || origin.username || origin.password || (process.env.NODE_ENV === 'production' && origin.protocol !== 'https:')) throw new Error('IMAGE_BASE_URL must be an exact HTTP(S) origin; HTTPS required in production');
export const imageConfig = { root: fileURLToPath(new URL('../../uploads/', import.meta.url)), base, host: process.env.IMAGE_HOST || '127.0.0.1', port: process.env.IMAGE_PORT || '3001' };
export const imagePathPattern = /^\/uploads\/(cafe|(?:user|product)\/[1-9]\d*)\/[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.webp$/;
const invalid = () => Object.assign(new Error('Invalid image; use a valid JPEG, PNG or WebP'), { status: 400 });
const formats = { '.jpg': ['jpeg','image/jpeg'], '.jpeg': ['jpeg','image/jpeg'], '.png': ['png','image/png'], '.webp': ['webp','image/webp'] };

// Sharp ignores PNG animation chunks and tolerates missing IEND; validate container too.
const validatePng = buffer => {
  if (!buffer.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) throw invalid();
  let offset = 8;
  while (offset + 12 <= buffer.length) {
    const size = buffer.readUInt32BE(offset);
    const end = offset + size + 12;
    if (end > buffer.length) throw invalid();
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    if (['acTL', 'fcTL', 'fdAT'].includes(type) || crc32(buffer.subarray(offset + 4, end - 4)) !== buffer.readUInt32BE(end - 4)) throw invalid();
    if (type === 'IEND') {
      if (size !== 0 || end !== buffer.length) throw invalid();
      return;
    }
    offset = end;
  }
  throw invalid();
};

export const convertImage = async file => {
  if (file.buffer.length > 5 * 1024 * 1024) throw Object.assign(new Error('Image exceeds 5 MiB'), { status: 413 });
  const allowed = formats[path.extname(file.originalname).toLowerCase()];
  if (!allowed || file.mimetype !== allowed[1]) throw invalid();
  try {
    if (allowed[0] === 'png') validatePng(file.buffer);
    const image = sharp(file.buffer, { limitInputPixels: 16000000, failOn: 'warning', animated: true });
    const meta = await image.metadata();
    if (meta.format !== allowed[0] || (meta.pages || 1) !== 1 || !meta.width || !meta.height || meta.width > 8192 || meta.height > 8192 || meta.width * meta.height > 16000000) throw invalid();
    return await image.rotate().webp({ quality: 80 }).toBuffer();
  } catch { throw invalid(); }
};

export const saveImage = async (buffer, directory) => {
  if (!/^(cafe|(?:user|product)\/[1-9]\d*)$/.test(directory)) throw new Error('Invalid image destination');
  const folder = path.join(imageConfig.root, directory);
  const name = randomUUID() + '.webp';
  const destination = path.join(folder, name);
  const temporary = destination + '.tmp';
  await mkdir(folder, { recursive: true });
  try {
    await writeFile(temporary, buffer, { flag: 'wx', mode: 0o600 });
    await rename(temporary, destination);
  } catch (error) { await unlink(temporary).catch(() => {}); throw error; }
  return { path: destination, url: `${imageConfig.base}/uploads/${directory}/${name}` };
};

// Only generated canonical URLs owned by this installation can trigger deletion.
export const removeImage = async value => {
  if (typeof value !== 'string' || !value.startsWith(imageConfig.base + '/uploads/')) return;
  const pathname = value.slice(imageConfig.base.length);
  if (!imagePathPattern.test(pathname)) return;
  try { await unlink(path.join(imageConfig.root, pathname.slice('/uploads/'.length))); }
  catch (error) { if (error.code !== 'ENOENT') console.error('Image cleanup failed:', error.code || 'unknown'); }
};
