import multer from 'multer';
import { convertImage } from '../utils/image.utils.js';

let active = 0;
export const uploadImage = (field, handler) => {
  const parse = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 16, parts: 17, fieldSize: 80 * 1024, fieldNameSize: 100 } }).single(field);
  return (req, res, next) => {
    const check = async () => {
      if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) return res.status(400).json({ message: 'Valid form fields required' });
      const urlField = field === 'logo' ? 'logoUrl' : 'imageUrl';
      if (Object.hasOwn(req.body, urlField) && (req.body[urlField] !== null || req.file)) return res.status(400).json({ message: 'Upload an image instead of supplying its URL; use JSON null to clear' });
      if (req.is('multipart/form-data')) {
        let size = 0;
        for (const [key, value] of Object.entries(req.body)) {
          if (typeof value !== 'string' || !value.isWellFormed() || value.includes('\ufffd')) return res.status(400).json({ message: 'Invalid or duplicate form field' });
          size += Buffer.byteLength(key) + Buffer.byteLength(value);
          if (['taxEnabled', 'taxInclusive', 'isActive', 'isAvailable'].includes(key)) {
            if (!['true','false'].includes(value)) return res.status(400).json({ message: 'Boolean fields must be true or false' });
            req.body[key] = value === 'true';
          }
        }
        if (size > 80 * 1024) return res.status(413).json({ message: 'Form fields too large' });
      }
      try {
        if (req.file) { req.image = await convertImage(req.file); req.body[urlField] = null; delete req.file; }
        if (req.aborted || res.destroyed) return;
        return handler ? await handler(req, res, next) : next();
      } catch (error) { return res.status(error.status || 400).json({ message: error.message }); }
    };
    if (req.is('application/json')) return check();
    if (!req.is('multipart/form-data')) return res.status(400).json({ message: 'Content-Type application/json or multipart/form-data required' });
    // ponytail: process-local admission; use shared limits before multi-instance deployment.
    if (active >= 4) return res.status(429).json({ message: 'Too many image requests' });
    active++;
    let released = false, completed = false, ended = false;
    const release = () => { if (completed && ended && !released) { active--; released = true; } };
    const end = () => { ended = true; release(); };
    res.once('finish', end); res.once('close', end);
    parse(req, res, async error => {
      try {
        if (req.aborted || res.destroyed) return;
        if (error) return res.status(['LIMIT_FILE_SIZE','LIMIT_FIELD_VALUE'].includes(error.code) ? 413 : 400).json({ message: 'Invalid upload or upload limit exceeded' });
        await check();
      } finally { delete req.file; delete req.image; completed = true; release(); }
    });
  };
};
