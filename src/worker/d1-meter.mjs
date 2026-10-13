export function meter(db){
  const totals={statements:0,rows_read:0,rows_written:0,duration_ms:0};
  const count=result=>{totals.rows_read+=result.meta?.rows_read||0;totals.rows_written+=result.meta?.rows_written||0;totals.duration_ms+=result.meta?.duration||0;return result;};
  const wrap=raw=>({_raw:raw,bind(...values){return wrap(raw.bind(...values));},
    async all(){totals.statements++;return count(await raw.all());},async run(){totals.statements++;return count(await raw.run());},
    async first(column){const r=await this.all(),row=r.results[0];return column?(row?.[column]??null):(row??null);},
  });
  return {totals,db:{prepare(sql){return wrap(db.prepare(sql));},async batch(statements){
    totals.statements+=statements.length;return (await db.batch(statements.map(s=>s._raw))).map(count);
  }}};
}
