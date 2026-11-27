import { z } from 'zod';

export const normalizePhone = value => String(value)
  .replace(/[০-৯]/g, digit => String('০১২৩৪৫৬৭৮৯'.indexOf(digit)))
  .replace(/[\s-]/g, '')
  .replace(/^\+?88(?=01)/, '');

export const objectId = z.string().regex(/^[a-fA-F0-9]{24}$/, 'Invalid id');
export const idParams = z.strictObject({ id: objectId });
export const month = z.string().regex(/^20\d{2}-(0[1-9]|1[0-2])$/, 'Use the format YYYY-MM');
export const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the format YYYY-MM-DD').refine(value => {
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}, 'Enter a valid date');
export const text = max => z.string().trim().min(1, 'This field is required').max(max);
export const optionalText = max => z.string().trim().max(max);
/** Money is whole taka only. */
export const taka = z.number().int('Use a whole number of taka').min(0).max(1_000_000_000);
export const positiveTaka = taka.min(1, 'Amount must be at least 1');
export const phone = z.string().trim().max(20).transform(normalizePhone)
  .pipe(z.string().regex(/^01[3-9]\d{8}$/, 'Enter a valid mobile number (01XXXXXXXXX)'));
export const optionalPhone = z.union([z.literal(''), phone]);
export const email = z.string().trim().max(120).toLowerCase().pipe(z.email('Enter a valid email address'));
export const password = z.string().min(8, 'At least 8 characters').max(128)
  .regex(/[A-Za-z]/, 'Include a letter').regex(/\d/, 'Include a digit');
export const yesNo = z.enum(['yes', 'no']);
export const activeStatus = z.enum(['active', 'inactive']);

/** Query string shared by every table: page, limit, search, sort, order, format plus module filters. */
export function listQuery({ sort = ['createdAt'], defaultSort = sort[0], defaultOrder = 'desc', filters = {} } = {}) {
  const integer = max => z.string().regex(/^[1-9]\d*$/, 'Use a positive number').transform(Number).pipe(z.number().max(max));
  return z.strictObject({
    page: integer(100000).default(1),
    limit: integer(500).default(10),
    search: z.string().trim().max(100).optional(),
    sort: z.enum(sort).default(defaultSort),
    order: z.enum(['asc', 'desc']).default(defaultOrder),
    format: z.enum(['json', 'csv']).optional(),
    ...filters,
  });
}
