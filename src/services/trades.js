const fields = 'trade_id, client, symbol, quantity, price, timestamp';
function where(filters, values = []) {
 const clauses = [];
 for (const [key, operator] of [['symbol','='], ['from','>='], ['to','<=']]) {
  if (filters[key] !== undefined) { values.push(filters[key]); clauses.push(`${key === 'symbol' ? 'symbol' : 'timestamp'} ${operator} $${values.length}`); }
 }
 return { values, clauses };
}
async function list(db, filters, page, jobId) {
 const { values, clauses } = where(filters);
 if (jobId) { values.push(jobId); clauses.push(`job_id = $${values.length}`); }
 if (page.cursor) {
  values.push(page.cursor.ts, page.cursor.id);
  clauses.push(`(timestamp, trade_id) < ($${values.length-1}::timestamptz, $${values.length}::varchar)`);
 }
 values.push(page.limit + 1);
 const { rows } = await db.query(`SELECT ${fields} FROM ${jobId ? 'extraction_results' : 'trades'} ${clauses.length ? 'WHERE ' + clauses.join(' AND ') : ''} ORDER BY timestamp DESC, trade_id DESC LIMIT $${values.length}`, values);
 const data = rows.slice(0, page.limit), last = data.at(-1);
 const nextCursor = rows.length > page.limit ? Buffer.from(JSON.stringify({ v: 1, scope: page.scope, ts: last.timestamp, id: last.trade_id })).toString('base64url') : null;
 return { success: true, count: data.length, nextCursor, data };
}
module.exports = { where, list, fields };
