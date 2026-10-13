import {DatabaseSync} from 'node:sqlite';
import {readFile} from 'node:fs/promises';

// Offline SQL verification only. This is not a Worker runtime dependency.
export class LocalD1 {
  constructor(file=':memory:'){this.sqlite=new DatabaseSync(file);this.sqlite.exec('PRAGMA foreign_keys=ON');}
  async migrate(){for(const file of ['0001_storage.sql','0002_runtime.sql','0003_interactive.sql'])this.sqlite.exec(await readFile(new URL('../../migrations/'+file,import.meta.url),'utf8'));}
  prepare(sql) {
    const db=this,make=values=>({sql,values,bind(...bound){return make(bound);},
      async all(){const results=db.sqlite.prepare(sql).all(...values);return {success:true,results,meta:{changes:0}};},
      async first(column){const row=db.sqlite.prepare(sql).get(...values);return column?(row?.[column]??null):(row??null);},
      async run(){const result=db.sqlite.prepare(sql).run(...values);return {success:true,results:[],meta:{changes:Number(result.changes)}};},
    });return make([]);
  }
  async batch(statements) {
    this.sqlite.exec('BEGIN IMMEDIATE');
    try {const result=[];for(const statement of statements)result.push(await statement.run());this.sqlite.exec('COMMIT');return result;}
    catch(error){this.sqlite.exec('ROLLBACK');throw error;}
  }
  close(){this.sqlite.close();}
}
