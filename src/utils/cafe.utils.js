// cek data yang boleh masuk, field lain jangan ikut disimpan
export const validateCafeSetting = (body, update = false) => {
  const fields = ['name', 'address', 'logoUrl', 'taxEnabled', 'taxName', 'taxRate', 'taxInclusive', 'receiptPaperSize', 'socialMedia'];
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'data harus berupa object' };
  if (!Object.keys(body).length || Object.keys(body).some(key => !fields.includes(key))) return { error: 'field tidak valid' };
  if (!update && (body.name === undefined || body.address === undefined)) return { error: 'nama dan alamat wajib diisi' };

  const data = {};
  for (const key of Object.keys(body)) {
    const value = body[key];

    if (key === 'socialMedia') {
      if (value !== null && (typeof value !== 'string' || !value.isWellFormed() || /[\p{Cc}\u2028\u2029]/u.test(value) || [...value.trim()].length > 200)) return { error: 'socialMedia must be single-line text up to 200 characters or null' };
      data[key] = value?.trim() || null;
    }

    if (key === 'receiptPaperSize') {
      if (!['58mm', '80mm'].includes(value)) return { error: 'receiptPaperSize must be 58mm or 80mm' };
      data[key] = value;
    }

    if (['name', 'address', 'taxName'].includes(key)) {
      const limit = key === 'name' ? 150 : key === 'taxName' ? 50 : 65535;
      if (typeof value !== 'string' || !value.isWellFormed() || !value.trim() || [...value.trim()].length > limit || (key === 'address' && Buffer.byteLength(value.trim()) > 65535)) return { error: `${key} tidak valid` };
      data[key] = value.trim();
    }

    if (['taxEnabled', 'taxInclusive'].includes(key)) {
      if (typeof value !== 'boolean') return { error: `${key} harus boolean` };
      data[key] = value;
    }

    if (key === 'taxRate') {
      if (!['number', 'string'].includes(typeof value) || !/^\d{1,3}(\.\d{1,2})?$/.test(String(value)) || Number(value) > 100) return { error: 'taxRate harus 0 sampai 100, maksimal 2 desimal' };
      data[key] = String(value);
    }

    if (key === 'logoUrl') {
      if (value === null) {
        data[key] = null;
        continue;
      }
      return { error: 'Upload a logo instead of supplying logoUrl' };
    }
  }

  return { data };
};
