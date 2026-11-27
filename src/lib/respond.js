const CSV_ROW_LIMIT = 10000;

/** Success envelope: `{ success, data, message, ...extra }`. */
export function send(res, data, { status = 200, message = '', ...extra } = {}) {
  res.status(status).json({ success: true, data, message, ...extra });
}

const cell = value => {
  let out = value == null ? '' : Array.isArray(value) ? value.join('; ') : typeof value === 'object' && !(value instanceof Date) ? JSON.stringify(value) : value instanceof Date ? value.toISOString() : String(value);
  if (/^\s*[=+\-@]/.test(out) && typeof value !== 'number') out = `'${out}`; // spreadsheet formula injection
  return `"${out.replaceAll('"', '""')}"`;
};

export function sendCsv(res, name, columns, rows) {
  const lines = [columns, ...rows.map(row => columns.map(column => row[column]))]
    .map(row => row.map(cell).join(','));
  res.type('text/csv').attachment(`${name}.csv`).send(`﻿${lines.join('\r\n')}\r\n`);
}

export const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const contains = value => ({ $regex: escapeRegex(value), $options: 'i' });

const pagination = (query, total) => ({ page: query.page, limit: query.limit, total, pages: Math.max(1, Math.ceil(total / query.limit)), hasMore: query.page * query.limit < total });

/** Server-side pagination and CSV export for a Mongo collection. `map` turns documents into API rows. */
export async function sendList(res, { model, filter = {}, query, map, name, columns, sortMap = {}, extra }) {
  const direction = query.order === 'asc' ? 1 : -1;
  const sort = { [sortMap[query.sort] || query.sort]: direction, _id: direction };
  const csv = query.format === 'csv';
  const find = model.find(filter).sort(sort).limit(csv ? CSV_ROW_LIMIT : query.limit);
  if (!csv) find.skip((query.page - 1) * query.limit);
  const rows = await map(await find.lean());
  if (csv) return sendCsv(res, name, columns, rows);
  send(res, rows, { pagination: pagination(query, await model.countDocuments(filter)), ...extra });
}

/** The same behaviour for rows that are computed in memory (dues, reports). */
export function sendRows(res, { rows, query, name, columns, extra }) {
  const direction = query.order === 'asc' ? 1 : -1;
  const sorted = [...rows].sort((a, b) => direction * (typeof a[query.sort] === 'number' && typeof b[query.sort] === 'number'
    ? a[query.sort] - b[query.sort] : String(a[query.sort] ?? '').localeCompare(String(b[query.sort] ?? ''))));
  if (query.format === 'csv') return sendCsv(res, name, columns, sorted);
  const offset = (query.page - 1) * query.limit;
  send(res, sorted.slice(offset, offset + query.limit), { pagination: pagination(query, rows.length), ...extra });
}
