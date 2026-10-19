/** Posidon R1.10.2 review controls: tooling/design only. No product edits. */
import {beforeEach,describe,expect,it} from 'vitest';
import {env} from 'cloudflare:test';
import {createD1Stats,instrumentD1,deriveCounts} from '../trace/d1-instrument';
const db=env.DB as D1Database;
beforeEach(async()=>{
 await db.prepare('CREATE TABLE IF NOT EXISTS manager_design_probe (id TEXT PRIMARY KEY,source_id TEXT NOT NULL)').run();
 await db.prepare('DELETE FROM manager_design_probe').run();
});
describe('Posidon independent R1.10.2 design and instrumentation controls',()=>{
 it('CE1 failed batch must not count its submitted statements as successfully completed',async()=>{
  const s=createD1Stats(),w=instrumentD1(db,s);
  await expect(w.batch([w.prepare("INSERT INTO manager_design_probe(id,source_id) VALUES ('ok','a')"),w.prepare("INSERT INTO manager_design_probe(id,source_id) VALUES ('bad',NULL)")])).rejects.toThrow();
  const d=deriveCounts(s);console.log('POSIDON[CE1]',JSON.stringify({batchCompleted:s.batchCompleted,batchFailed:s.batchFailed,batchResultRecords:s.batchResultRecords,...d}));
  expect(d.executionApiCallsCompleted).toBe(0);expect(d.statementsCompleted).toBe(0);
 });
 it('CONTROL retained100 item inserts plus2 grouped reads still exceed50 statements despite3 API calls',async()=>{
  const s=createD1Stats(),w=instrumentD1(db,s);
  await w.batch(Array.from({length:100},(_,i)=>w.prepare('INSERT INTO manager_design_probe(id,source_id) VALUES (?,?)').bind('row-'+i,'a')));
  const ids=Array.from({length:100},(_,i)=>'row-'+i);
  for(const chunk of [ids.slice(0,99),ids.slice(99)])await w.prepare('SELECT id FROM manager_design_probe WHERE source_id=? AND id IN ('+chunk.map(()=>'?').join(',')+')').bind('a',...chunk).all();
  const d=deriveCounts(s);expect(d.executionApiCallAttempts).toBe(3);expect(d.statementsAttempted).toBe(102);expect(d.statementsAttempted).toBeGreaterThan(50);
  console.log('POSIDON[CONTROL]',JSON.stringify({retainedItemInserts:100,groupedReads:2,stateUpdateAndEngineOverhead:'omitted: lower bound only',...d}));
 });
 it('CE2 proposed ProbeA without source must preserve accepted source-scoped lookup',async()=>{
  await db.prepare("INSERT INTO manager_design_probe(id,source_id) VALUES ('existing-foreign-id','source-b')").run();
  const accepted=await db.prepare('SELECT id FROM manager_design_probe WHERE id=? AND source_id=?').bind('existing-foreign-id','source-a').all();
  const proposed=await db.prepare('SELECT id FROM manager_design_probe WHERE id IN (?)').bind('existing-foreign-id').all();
  console.log('POSIDON[CE2]',JSON.stringify({accepted:accepted.results,proposed:proposed.results,note:'query-equivalence counterexample; not a claim of normal-path foreign writes'}));
  expect(proposed.results).toEqual(accepted.results);
 });
 it('CE3 bounded metadata reservoir must not overwrite an earlier unavailable record after saturation',async()=>{
  // Fake binding exercises ONLY instrument-memory behavior; no cloud quota claim.
  let value=0;
  const fake={prepare(){return {async run(){value++;return value===4096?{success:true}:{success:true,meta:{rows_written:value}};}};}} as unknown as D1Database;
  const s=createD1Stats(),w=instrumentD1(fake,s);
  for(let i=0;i<4097;i++)await w.prepare('FAKE').run();
  console.log('POSIDON[CE3]',JSON.stringify({completed:s.terminalCompleted,retainedRecords:s.metaRecords.length,lastRetainedRowsWritten:s.metaRecords.at(-1)?.rowsWritten}));
  expect(s.metaRecords.at(-1)?.hasRawMeta).toBe(false);
  expect(s.metaRecords.at(-1)?.rowsWritten).toBeUndefined();
 });
});
