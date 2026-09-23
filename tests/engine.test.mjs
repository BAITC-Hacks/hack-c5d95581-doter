import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createSession, processTurn } from '../lib/engine.mjs';

const read = name => JSON.parse(readFileSync(new URL('../data/'+name+'.json',import.meta.url),'utf8'));
const data = {scenarios:read('scenarios'),slots:read('slots'),actions:read('actions'),knowledge:read('knowledge_base'),backend:read('mock_backend')};
const decision = (id,slots={},extra={}) => ({scenarios:[{scenario_id:id,confidence:.96,reason:'Input-grounded test route'}],alternatives:[],language:'ru',slots,is_continuation:false,confirmation:'none',...extra});
const turn = (s,id,slots={},extra={},transcript='Данные запроса') => processTurn(s,decision(id,slots,extra),{transcript});
const emailChange = {phone:'+77010000001',contact_field:'email',new_value:'new@mail.example'};

test('invalid router ID and invalid/unknown slots cannot mutate state',()=>{
 const s=createSession(data), before=structuredClone(s.backend);
 const bad=turn(s,'SC999');
 assert.equal(bad.trace.scenarios[0].scenario_id,'SYS_UNCLEAR');
 assert.equal(bad.trace.status,'clarification');
 assert.equal(turn(s,'SC29',{...emailChange,phone:'123'}).trace.status,'invalid_input');
 assert.equal(turn(s,'SC29',{...emailChange,client_id:'C001'}).trace.status,'invalid_input');
 assert.deepEqual(s.backend,before);
});

test('write preview is read-only; separate explicit affirmation executes exactly once',()=>{
 const s=createSession(data),before=structuredClone(s.backend);
 const first=turn(s,'SC29',emailChange);
 assert.equal(first.trace.status,'awaiting_confirmation');
 assert.deepEqual(s.backend,before);
 assert.ok(first.trace.actions.some(a=>a.name==='update_contact'&&a.mode==='preview'));
 const premature=turn(s,'SC29',{}, {confirmation:'confirm'},'Хорошо, но я ещё проверю');
 assert.equal(premature.trace.status,'awaiting_confirmation');
 assert.deepEqual(s.backend,before);
 const done=processTurn(s,decision('SC29',{}, {confirmation:'confirm',is_continuation:true}),{turnId:'confirmed',transcript:'Да, верно.'});
 assert.equal(done.trace.status,'completed');
 assert.equal(s.backend.clients.find(c=>c.client_id==='C001').email,'new@mail.example');
 assert.equal(done.trace.actions.filter(a=>a.name==='update_contact'&&a.mode==='execute').length,1);
 assert.deepEqual(processTurn(s,decision('SC29'),{turnId:'confirmed',transcript:'Да'}),done);
 const replay=turn(s,'SC29',{}, {confirmation:'confirm'},'Да');
 assert.equal(replay.trace.status,'completed');
 assert.equal(s.operations.size,1);
 assert.equal(replay.trace.actions[0].result.already_done,true);
});

test('same-turn yes cannot authorize an operation that has never been previewed',()=>{
 const s=createSession(data);
 const out=turn(s,'SC29',emailChange,{confirmation:'confirm'},'Да');
 assert.equal(out.trace.status,'awaiting_confirmation');
 assert.equal(s.backend.clients[0].email,'arman.t@mail.example');
});

test('changed arguments invalidate prior confirmation and require a fresh preview',()=>{
 const s=createSession(data);turn(s,'SC29',emailChange);
 const change=turn(s,'SC29',{new_value:'different@mail.example'},{confirmation:'confirm'},'Да');
 assert.equal(change.trace.status,'awaiting_confirmation');
 assert.equal(s.backend.clients[0].email,'arman.t@mail.example');
 assert.equal(change.trace.confirmation.args.new_value,'different@mail.example');
 const out=turn(s,'SC29',{}, {confirmation:'confirm'},'Иә, дұрыс.');
 assert.equal(out.trace.status,'completed');
 assert.equal(s.backend.clients[0].email,'different@mail.example');
});

test('topic switch invalidates pending confirmation and preserves interrupted slots',()=>{
 const s=createSession(data);turn(s,'SC29',emailChange);
 const info=turn(s,'SC33',{city:'Astana'});
 assert.equal(info.trace.status,'completed');assert.equal(info.trace.confirmation,null);
 assert.deepEqual(info.state.suspended_scenarios,['SC29']);
 const back=turn(s,'SC29',{}, {confirmation:'confirm'},'Да');
 assert.equal(back.trace.status,'awaiting_confirmation');
 assert.equal(s.backend.clients[0].email,'arman.t@mail.example');
});

test('reject does not execute; session data and source data stay isolated',()=>{
 const s=createSession(data),other=createSession(data);
 turn(s,'SC29',emailChange);
 assert.equal(turn(s,'SC29',{}, {confirmation:'reject'},'Нет').trace.status,'cancelled');
 assert.equal(s.backend.clients[0].email,'arman.t@mail.example');
 turn(s,'SC29',emailChange);turn(s,'SC29',{}, {confirmation:'confirm'},'Да');
 assert.equal(other.backend.clients[0].email,'arman.t@mail.example');
 assert.equal(data.backend.clients[0].email,'arman.t@mail.example');
 assert.doesNotThrow(()=>JSON.stringify(turn(s,'SC33',{city:'Almaty'}).state));
 assert.equal('backend' in turn(other,'SC33',{city:'Almaty'}).state,false);
});

test('policy and claim ownership are checked against an explicitly supplied identity',()=>{
 const s=createSession(data);
 const p=turn(s,'SC25',{phone:'+77010000002',policy_number:'SQ-OGPO-104501'});
 assert.equal(p.trace.status,'identification');
 assert.ok(!p.reply.includes('2027-03-14'));
 const c=turn(createSession(data),'SC17',{phone:'+77010000001',claim_number:'CL-500287'});
 assert.equal(c.trace.status,'identification');
});

test('identification by a claim uses claimant, not third-party policy owner',()=>{
 const s=createSession(data),out=turn(s,'SC17',{claim_number:'CL-500287'});
 assert.equal(out.state.client_id,'C005');
 assert.equal(out.trace.status,'completed');
 assert.match(out.reply,/412000/);
});

test('urgency comes first and extra intent fields stay in their own scenario map',()=>{
 const s=createSession(data);
 const out=processTurn(s,decision('SC33',{city:'Astana',fraud_details:'Мне звонят и просят код'},{
  scenarios:[{scenario_id:'SC33',confidence:.95,reason:'office'},{scenario_id:'SC38',confidence:.96,reason:'fraud'}]
 }),{transcript:'Нужен офис, ещё мне звонят и просят код'});
 assert.equal(out.trace.scenarios[0].scenario_id,'SC38');
 assert.deepEqual(out.state.queued_scenarios,['SC33']);
 assert.equal(out.state.scenario_slots.SC33.city,'Astana');
 assert.equal(out.state.scenario_slots.SC38.city,undefined);
});

test('quotation follows organizer formula and relative dates use the dataset date',()=>{
 const out=turn(createSession(data),'SC01',{region:'almaty',vehicle_type:'car',drivers_iin:['850314300121']});
 assert.equal(out.trace.actions.find(a=>a.name==='calc_ogpo_price').result.price,30400);
 const payment=turn(createSession(data),'SC30',{phone:'+77010000003',payment_date:'вчера'});
 assert.equal(payment.trace.slots.payment_date,'2026-09-30');
 assert.equal(payment.trace.status,'handoff');
 assert.match(payment.reply,/31200/);
});

test('all forty routes accept empty slots without throwing or claiming invented success',()=>{
 for(const sc of data.scenarios.scenarios){
  const result=turn(createSession(data),sc.scenario_id);
  assert.equal(typeof result.reply,'string',sc.scenario_id);
  assert.ok(result.reply.length,sc.scenario_id);
  assert.ok(!/undefined|NaN|\{[a-z_]+\}/.test(result.reply),sc.scenario_id);
 }
});

test('unsupported booking returns honest handoff without a booking mutation',()=>{
 const s=createSession(data),before=structuredClone(s.backend);
 const out=turn(s,'SC21',{policy_number:'SQ-DMS-604220',doctor_specialty:'therapist',city:'Astana',preferred_date:'2026-10-02'});
 assert.equal(out.trace.status,'handoff');
 assert.equal(out.trace.confirmation,null);
 assert.deepEqual(s.backend,before);
 assert.ok(!out.reply.includes('Записала'));
});

test('cancellation is gated and cannot refund a policy with a paid claim',()=>{
 const s=createSession(data);
 const denied=turn(s,'SC28',{policy_number:'SQ-CASCO-204118',cancel_reason:'продал машину'});
 assert.equal(denied.trace.status,'handoff');
 assert.equal(s.backend.policies.find(p=>p.policy_number==='SQ-CASCO-204118').status,undefined);
 const t=createSession(data);
 assert.equal(turn(t,'SC28',{policy_number:'SQ-OGPO-103990',cancel_reason:'продал машину'}).trace.status,'awaiting_confirmation');
 turn(t,'SC28',{}, {confirmation:'confirm'},'Да');
 assert.equal(t.backend.policies.find(p=>p.policy_number==='SQ-OGPO-103990').status,'cancelled');
});

test('mock policy issuance mutates only after confirmation and replay cannot issue again',()=>{
 const s=createSession(data),count=s.backend.policies.length;
 const input={vehicle_plate:'888ABC02',drivers_iin:['850314300121'],phone:'+77071234567',vehicle_type:'car'};
 assert.equal(turn(s,'SC02',input).trace.status,'awaiting_confirmation');
 assert.equal(s.backend.policies.length,count);
 assert.equal(turn(s,'SC02',{}, {confirmation:'confirm'},'Да').trace.status,'completed');
 assert.equal(s.backend.policies.length,count+1);
 assert.equal(s.backend.policies.at(-1).status,'pending_payment');
 turn(s,'SC02',{}, {confirmation:'confirm'},'Да');
 assert.equal(s.backend.policies.length,count+1);
});

test('a negative acknowledgement plus a new topic does not cancel the new request',()=>{
 const s=createSession(data);turn(s,'SC29',emailChange);
 const out=turn(s,'SC33',{city:'Astana'},{confirmation:'reject'},'Нет, лучше адрес офиса');
 assert.equal(out.trace.status,'completed');
 assert.match(out.reply,/Mangilik El/);
 assert.equal(out.trace.confirmation,null);
});

test('unknown third-party claim phone never reuses the previously identified claimant',()=>{
 const s=createSession(data);
 turn(s,'SC25',{phone:'+77010000001',policy_number:'SQ-OGPO-104501'});
 const input={culprit_vehicle_plate:'101AAA02',incident_date:'2026-09-30',incident_description:'ДТП',phone:'+77079999999'};
 const preview=turn(s,'SC12',input);
 assert.equal(preview.trace.status,'awaiting_confirmation');
 turn(s,'SC12',{}, {confirmation:'confirm'},'Да');
 const created=s.backend.claims.at(-1);
 assert.equal(s.backend.clients.find(c=>c.client_id===created.client_id).phone,'+77079999999');
 assert.notEqual(created.client_id,'C001');
});

test('contradictory identifiers do not expose policy data',()=>{
 const s=createSession(data);
 const out=turn(s,'SC25',{phone:'+77010000001',iin:'920607400233',policy_number:'SQ-OGPO-104501'});
 assert.equal(out.trace.status,'identification');
 assert.equal(out.state.client_id,null);
 assert.ok(!out.trace.actions.some(a=>a.name==='get_policy'));
});


test('victim claim requires the culprit OGPO policy and never uses CASCO',()=>{
 const s=createSession(data),before=structuredClone(s.backend);
 const input={culprit_vehicle_plate:'555KZT14',incident_date:'2026-09-30',incident_description:'ДТП',phone:'+77010000005'};
 const missing=turn(s,'SC12',input);
 assert.equal(missing.trace.status,'handoff');
 assert.equal(missing.trace.confirmation,null);
 assert.equal(missing.trace.actions.find(a=>a.name==='get_policy').result.error.code,'not_found');
 assert.ok(!missing.trace.actions.some(a=>a.name==='create_claim'));
 turn(s,'SC12',{}, {confirmation:'confirm'},'Да');
 assert.deepEqual(s.backend,before);
 // A matching OGPO later in the list must be selected even when CASCO has the same plate.
 const ogpo=structuredClone(s.backend.policies.find(p=>p.policy_number==='SQ-OGPO-104501'));
 ogpo.policy_number='SQ-OGPO-999999';ogpo.details.vehicle_plate=input.culprit_vehicle_plate;
 s.backend.policies.push(ogpo);
 const preview=turn(s,'SC12',input);
 assert.equal(preview.trace.status,'awaiting_confirmation');
 assert.equal(preview.trace.actions.find(a=>a.name==='get_policy').result.policy_number,ogpo.policy_number);
 assert.equal(turn(s,'SC12',{}, {confirmation:'confirm'},'Да').trace.status,'completed');
 assert.equal(s.backend.claims.at(-1).policy_number,ogpo.policy_number);
 assert.equal(s.backend.claims.at(-1).claim_type,'ogpo_victim');
});

test('CASCO renewal prices vehicle age at the new coverage start',()=>{
 const s=createSession(data),count=s.backend.policies.length;
 const quote=turn(s,'SC03',{car_value:12000000,car_year:2019,franchise:50000});
 assert.equal(quote.trace.actions.find(a=>a.name==='calc_casco_price').result.price,540000);
 const preview=turn(s,'SC27',{policy_number:'SQ-CASCO-204118'});
 assert.equal(preview.trace.status,'awaiting_confirmation');
 assert.equal(preview.trace.actions.find(a=>a.name==='renew_policy').result.price,702000);
 assert.equal(s.backend.policies.length,count);
 const done=turn(s,'SC27',{}, {confirmation:'confirm'},'Да');
 assert.equal(done.trace.status,'completed');
 const renewal=s.backend.policies.at(-1);
 assert.equal(renewal.start_date,'2027-03-15');
 assert.equal(renewal.end_date,'2028-03-14');
 assert.equal(renewal.premium,702000);
 assert.equal(done.trace.actions.find(a=>a.name==='renew_policy').result.price,renewal.premium);
});

test('new A to B to A contact updates each confirm and execute while delivery retries remain idempotent',()=>{
 const s=createSession(data),ids=[];
 let previous=s.backend.clients[0].email;
 for(const [i,value] of ['first@example.com','second@example.com','first@example.com'].entries()){
   const preview=turn(s,'SC29',{...emailChange,new_value:value});
   assert.equal(preview.trace.status,'awaiting_confirmation');
   assert.equal(s.backend.clients[0].email,previous);
   ids.push(preview.trace.confirmation.operation_id);
   const options={turnId:'contact-update-'+i,transcript:'Да'};
   const done=processTurn(s,decision('SC29',{}, {confirmation:'confirm'}),options);
   assert.equal(done.trace.status,'completed');
   assert.equal(s.backend.clients[0].email,value);
   assert.equal(done.trace.actions.find(a=>a.name==='update_contact').deduplicated,undefined);
   assert.deepEqual(processTurn(s,decision('SC29',{}, {confirmation:'confirm'}),options),done);
   assert.equal(turn(s,'SC29',{}, {confirmation:'confirm'},'Да').trace.actions[0].result.already_done,true);
   assert.equal(s.operations.size,i+1);
   previous=value;
 }
 assert.equal(new Set(ids).size,3);
});
