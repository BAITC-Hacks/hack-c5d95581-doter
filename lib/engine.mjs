import { randomUUID } from 'node:crypto';
import { lookupPolicyKnowledge } from './knowledge.mjs';

const TODAY = '2026-10-01';
const clone = value => structuredClone(value);
const has = v => v !== undefined && v !== null && v !== '' && (!Array.isArray(v) || v.length > 0);
const err = (code, message) => ({ error: { code, message } });
const tr = (s, ru, kk) => s.reply_language === 'kk' ? kk : ru;
const stable = v => Array.isArray(v) ? '[' + v.map(stable).join(',') + ']' : v && typeof v === 'object' ? '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}' : JSON.stringify(v);
const mask = v => String(v).replace(/([^\s@])[^@\s]*@/g, '$1***@').replace(/\+7\d{10}/g, x => '+7***' + x.slice(-4)).replace(/\b\d{12}\b/g, x => '********' + x.slice(-4));
const aliases = {
  city: {'алматы':'Almaty','астана':'Astana','шымкент':'Shymkent','караганда':'Karaganda','қарағанды':'Karaganda','актобе':'Aktobe','ақтөбе':'Aktobe','атырау':'Atyrau','павлодар':'Pavlodar','оскемен':'Oskemen','өскемен':'Oskemen'},
  region: {'алматы':'almaty','астана':'astana','другой':'other','басқа':'other'},
  vehicle_type: {'легковая':'car','легковой':'car','жеңіл':'car','грузовая':'truck','мотоцикл':'motorcycle'},
  product_type: {'огпо':'ogpo','каско':'casco','дмс':'dms'},
  contact_field: {'телефон':'phone','почта':'email','адрес':'address','пошта':'email','мекенжай':'address'},
  property_type: {'квартира':'apartment','пәтер':'apartment','дом':'house','үй':'house'}
};
function normalize(d, value) {
  if (typeof value === 'string') value = value.trim();
  if (d.name === 'phone' && typeof value === 'string') {
    value = value.replace(/[ ()-]/g, '');
    if (/^8\d{10}$/.test(value)) value = '+7' + value.slice(1);
    if (/^7\d{10}$/.test(value)) value = '+' + value;
  }
  if (/plate$/.test(d.name) && typeof value === 'string') value = value.replace(/\s/g, '').toUpperCase();
  if (d.type === 'enum') {
    value = aliases[d.name]?.[String(value).toLowerCase()] ?? value;
    value = d.values.find(v => String(v).toLowerCase() === String(value).toLowerCase()) ?? value;
  }
  if (d.type === 'date' && typeof value === 'string') value = ({сегодня:TODAY,бүгін:TODAY,завтра:'2026-10-02',ертең:'2026-10-02',вчера:'2026-09-30',кеше:'2026-09-30'})[value.toLowerCase()] ?? value;
  if (d.type === 'integer' && typeof value === 'string' && /^\d+$/.test(value)) value = Number(value);
  if (d.type === 'boolean' && typeof value === 'string') {
    if (['да','иә','true'].includes(value.toLowerCase())) value = true;
    else if (['нет','жоқ','false'].includes(value.toLowerCase())) value = false;
  }
  let ok = false;
  switch (d.type) {
    case 'string': case 'text': ok = typeof value === 'string' && value.length > 0 && value.length <= 4000; break;
    case 'enum': ok = d.values.includes(value); break;
    case 'integer': ok = Number.isSafeInteger(value) && (d.name === 'traveler_max_age' ? value >= 0 : value > 0); break;
    case 'boolean': ok = typeof value === 'boolean'; break;
    case 'list': ok = Array.isArray(value) && value.length > 0 && value.length <= 30 && value.every(v => typeof v === 'string'); break;
    case 'date': ok = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,10) === value; break;
  }
  if (ok && d.pattern) ok = (Array.isArray(value) ? value : [value]).every(v => new RegExp(d.pattern).test(v));
  if (ok && d.name === 'car_year') ok = value >= 1900 && value <= 2026;
  return ok ? {value} : err('invalid_input',d.name);
}
function yes(text) {
  const t = String(text).trim().toLowerCase().replace(/[.,!?\s]+$/u,'');
  return /^(да|да верно|да, верно|да всё верно|да, всё верно|всё верно|подтверждаю|да подтверждаю|да, подтверждаю|согласен|согласна|давайте|да оформляйте|да, оформляйте|иә|ия|иә дұрыс|иә, дұрыс|дұрыс|растаймын|иә растаймын|иә, растаймын|келісемін)$/u.test(t);
}
const no = text => /^(нет|жоқ|не подтверждаю|отмена|отменить|бас тартамын)(?:[.,!?\s]|$)/iu.test(String(text).trim());
function status(p) { return p.status ?? (p.start_date > TODAY ? 'not_started' : p.end_date < TODAY ? 'expired' : 'active'); }
const customer = s => s.backend.clients.find(c => c.client_id === s.client_id);
function findPolicy(s,a,thirdParty=false) {
  return s.backend.policies.find(p => (a.policy_number ? p.policy_number === a.policy_number : p.details?.vehicle_plate === (a.culprit_vehicle_plate ?? a.vehicle_plate)) && (thirdParty ? p.product === 'ogpo' : p.client_id === s.client_id));
}
const findClaim = (s,a) => s.backend.claims.find(c => c.claim_number === a.claim_number && c.client_id === s.client_id);
function nextId(prefix, list, field) {
  let n = 900001; while (list.some(x => x[field] === prefix+n)) n++; return prefix+n;
}
export function createSession(data,{id=randomUUID()}={}) {
  if (!data?.scenarios?.scenarios || !data?.slots?.slots || !data?.actions?.actions || !data?.knowledge || !data?.backend) throw new TypeError('Full organizer data objects are required');
  return {id,data,backend:clone(data.backend),today:TODAY,turn:0,language:'ru',reply_language:'ru',client_id:null,identity:{},
    scenario_slots:{},active_scenario:null,queued_scenarios:[],suspended_scenarios:[],pending_confirmation:null,status:'ready',
    last_decision:null,last_reply:'',low_confidence_count:0,operation_context:null,operations:new Map(),turns:new Map(),journal:[],completed:new Set()};
}
function state(s) {
  return clone({id:s.id,today:TODAY,turn:s.turn,language:s.language,reply_language:s.reply_language,client_id:s.client_id,identity:s.identity,
    active_scenario:s.active_scenario,queued_scenarios:s.queued_scenarios,suspended_scenarios:s.suspended_scenarios,
    scenario_slots:s.scenario_slots,slots:s.scenario_slots[s.active_scenario]??{},pending_confirmation:s.pending_confirmation,status:s.status,
    last_reply:s.last_reply,last_decision:s.last_decision});
}
function ask(s,field) {
  return s.data.slots.slots.find(x=>x.name===field)?.prompt?.[s.reply_language] ?? tr(s,'Уточните данные запроса.','Сұраныс деректерін нақтылаңыз.');
}
function priceOgpo(s,a) {
  const q=s.data.knowledge.products.ogpo.pricing;
  if (!a.vehicle_type || !a.drivers_iin?.length) return err('invalid_input',!a.vehicle_type?'vehicle_type':'drivers_iin');
  const region=a.region ?? q.region_by_plate_code[a.vehicle_plate?.slice(-2)] ?? q.region_by_plate_code.default;
  const coef=Math.max(...a.drivers_iin.map(iin=>q.bm_coef[s.backend.clients.find(c=>c.iin===iin)?.bm_class ?? s.backend.defaults.unknown_iin_bm_class]));
  return {price:Math.round(q.base_by_region_kzt[region]*q.vehicle_type_coef[a.vehicle_type]*coef*q.term_coef[String(a.term_months??12)]),region};
}
function priceCasco(s,a,startDate=TODAY) {
  const q=s.data.knowledge.products.casco.pricing, age=Number(startDate.slice(0,4))-a.car_year;
  if (age<0 || age>q.max_car_age.Standard) return err('not_eligible','Vehicle age');
  const rate=age<=3?q.rate_by_car_age['0-3']:age<=7?q.rate_by_car_age['4-7']:q.rate_by_car_age['8-10'];
  return {price:Math.round(a.car_value*rate*q.franchise_coef[String(a.franchise??0)]*q.package_coef.Standard)};
}
function priceTravel(s,a) {
  const groups={
    A:['russia','россия','ресей','georgia','грузия','uzbekistan','узбекистан','өзбекстан','kyrgyzstan','кыргызстан','қырғызстан','armenia','армения','azerbaijan','азербайджан','belarus','беларусь','tajikistan','таджикистан'],
    B:['germany','германия','france','франция','italy','италия','spain','испания','uk','united kingdom','великобритания','ұлыбритания','poland','польша','austria','австрия','greece','греция','switzerland','швейцария','netherlands','нидерланды'],
    C:['turkey','турция','түркия','uae','оаэ','бәә','thailand','таиланд','тайланд','egypt','египет','мысыр'],
    D:['usa','сша','ақш','united states','canada','канада']};
  const zone=Object.keys(groups).find(z=>groups[z].includes(String(a.trip_country).toLowerCase()));
  if (!zone || a.traveler_max_age>75) return err('not_eligible','An operator must confirm country/age eligibility');
  const days=(Date.parse(a.trip_end)-Date.parse(a.trip_start))/86400000+1;
  if (days<1 || a.trip_start<TODAY) return err('invalid_input','trip_start');
  const z=s.data.knowledge.products.travel.zones[zone];
  return {price:z.rate_per_day_kzt*days*a.travelers_count*(a.traveler_max_age>=65?2:1),zone,coverage:z.coverage};
}
function knowledge(s,sc,a) {
  const k=s.data.knowledge, id=sc.scenario_id;
  const facts=({
    SC03:k.products.casco,SC07:k.products.property,SC08:k.products.accident,SC09:k.products.dms,SC11:k.claims.road_accident_now,
    SC24:k.products.dms.e_card,SC31:k.payments,SC32:k.bonus_malus,SC34:k.app_help,SC38:k.fraud_policy
  })[id];
  const answers={
    SC09:tr(s,'Индивидуальный ДМС: Базовая — '+k.products.dms.individual_price_per_year_kzt.Basic+' тенге в год, Комфорт — '+k.products.dms.individual_price_per_year_kzt.Comfort+' тенге в год. Какую программу уточнить?','Жеке ДМС: Базалық — жылына '+k.products.dms.individual_price_per_year_kzt.Basic+' теңге, Комфорт — '+k.products.dms.individual_price_per_year_kzt.Comfort+' теңге. Қай бағдарламаны нақтылайсыз?'),
    SC11:tr(s,'Если есть пострадавшие, сразу звоните 112; включите аварийную сигнализацию и выставьте знак. Сфотографируйте место и не перемещайте автомобили до оформления.','Зардап шеккендер болса, бірден 112-ге хабарласыңыз; апаттық шамды жағып, белгі қойыңыз. Оқиға орнын суретке түсіріп, рәсімделгенге дейін көліктерді қозғамаңыз.'),
    SC24:tr(s,'Электронная карта ДМС находится в приложении «Мои полисы»; в клинике достаточно показать её на экране.','ДМС электрондық картасы қосымшаның «Менің полистерім» бөлімінде; емханада оны экраннан көрсету жеткілікті.'),
    SC31:tr(s,'Оплатить можно картой в приложении или на сайте, по ссылке из SMS либо терминалом в офисе; наличные не принимаются. Рассрочка: КАСКО — два или четыре платежа, индивидуальный ДМС — два; ОГПО и путешествия — полная оплата.','Қосымшада не сайтта картамен, SMS сілтемесімен немесе кеңседегі терминалмен төлеуге болады; қолма-қол ақша қабылданбайды. КАСКО — екі не төрт төлем, жеке ДМС — екі; ОГПО мен сапар сақтандыруы толық төленеді.'),
    SC32:tr(s,'За год без ДТП по вашей вине класс увеличивается на один, после ДТП по вашей вине уменьшается на два.','Өз кінәңізбен ЖКО болмаса, жыл сайын сынып бірге өседі; кінәлі ЖКО-дан кейін екіге төмендейді.'),
    SC34:tr(s,'Для входа используйте телефон и одноразовый код из SMS. Если код не пришёл, проверьте номер и повторите запрос через 60 секунд; доступно не более пяти кодов в час.','Кіру үшін телефон мен SMS-тегі бір реттік кодты пайдаланыңыз. Код келмесе, нөмірді тексеріп, 60 секундтан кейін сұратыңыз; сағатына бес кодтан артық жіберілмейді.'),
    SC38:tr(s,'Saqta никогда не запрашивает коды из SMS, CVV или PIN и не просит переводить деньги на личную карту.','Saqta ешқашан SMS кодын, CVV не PIN сұрамайды және жеке картаға ақша аударуды талап етпейді.')
  };
  if (id==='SC18') {
    const docs=k.claims.documents[a.product_type==='ogpo'?'ogpo_victim':a.product_type];
    if (!docs) return err('not_found','Document list');
    const translations={
      'ID card':['удостоверение личности','жеке куәлік'],'Driving licence':['водительское удостоверение','жүргізуші куәлігі'],
      'Vehicle registration certificate':['техпаспорт','техпаспорт'],'Road accident documents from the police':['документы полиции о ДТП','ЖКО туралы полиция құжаттары'],
      'Bank details':['банковские реквизиты','банк деректемелері'],'Photos of the damage':['фотографии повреждений','зақым суреттері'],
      'Police documents (if police was involved)':['документы полиции, если её вызывали','полиция шақырылса, оның құжаттары'],'Policy number':['номер полиса','полис нөмірі'],
      'Act from the building management company (for water damage) or fire service report (for fire)':['акт управляющей компании при затоплении или пожарной службы при пожаре','су басса басқарушы компанияның, өрт болса өрт қызметінің актісі'],
      'Medical certificate from the trauma centre or hospital':['справка из травмпункта или больницы','травмпункттің немесе аурухананың анықтамасы'],
      'Medical documents from abroad':['медицинские документы из-за границы','шетелдегі медициналық құжаттар'],
      'Receipts (only for expenses agreed with assistance)':['чеки расходов, согласованных с ассистансом','ассистанс мақұлдаған шығындардың түбіртектері']};
    return {answer:docs.map(x=>translations[x]?.[s.reply_language==='kk'?1:0]??x).join(', '),facts:docs};
  }
  if (id==='SC40') return lookupPolicyKnowledge(k,a,s.reply_language);
  return facts?{answer:answers[id]??'',facts}:err('not_found','Knowledge topic');
}
function handoffContext(s,{reason,transcript,actions,priorConfirmation,turnId}) {
  const currentAction = actions.filter(action=>action.name!=='transfer_to_operator').at(-1);
  let previousAction=null,previousTurn=null;
  if(!currentAction)for(const past of [...s.turns.values()].reverse()) {
    previousAction=past.trace.actions.filter(action=>action.name!=='transfer_to_operator').at(-1);
    if(previousAction){previousTurn=past.trace.turn_id;break;}
  }
  const latest = currentAction ?? previousAction;
  const latestAction = latest ? {...clone(latest),turn_id:currentAction?turnId:previousTurn} : null;
  const topic = s.active_scenario;
  return {
    reason,latest_request:String(transcript).slice(0,8000),client_id:s.client_id,
    scenario_id:topic,active_scenario:topic,queued_scenarios:[...s.queued_scenarios],suspended_scenarios:[...s.suspended_scenarios],
    slots:clone(s.scenario_slots[topic]??{}),scenario_slots:clone(s.scenario_slots),
    latest_action:latestAction,pending_confirmation:clone(s.pending_confirmation),
    confirmation_status:s.pending_confirmation?'awaiting_confirmation':priorConfirmation?(s.operations.has(priorConfirmation.operation_key)?'executed':'cancelled'):'none',
    summary:tr(s,'Причина передачи: ','Беру себебі: ')+reason+'. '+tr(s,'Последний запрос: ','Соңғы сұраныс: ')+mask(String(transcript).slice(0,500))+
      (latestAction?'. '+tr(s,'Последнее действие: ','Соңғы әрекет: ')+latestAction.name+' ('+latestAction.mode+(latestAction.result?.error?', '+latestAction.result.error.code:'')+').':''),
  };
}
function runAction(s,sc,name,a,execute=false) {
  const p=findPolicy(s,a,sc.scenario_id==='SC12'),c=customer(s),k=s.data.knowledge;
  switch(name) {
    case 'find_client': return c?{client_id:c.client_id,full_name:c.full_name}:err('not_found','Client');
    case 'get_policies': return c?{policies:s.backend.policies.filter(p=>p.client_id===c.client_id).map(p=>({...p,status:status(p)}))}:err('not_found','Client');
    case 'get_policy': return p?{policy_number:p.policy_number,product:p.product,status:status(p),end_date:p.end_date}:err('not_found','Policy');
    case 'get_bm_class': return {bm_class:s.backend.clients.find(c=>c.iin===(a.iin??a.new_driver_iin??a.drivers_iin?.[0]))?.bm_class??s.backend.defaults.unknown_iin_bm_class};
    case 'calc_ogpo_price': return priceOgpo(s,a);
    case 'calc_casco_price': return priceCasco(s,a);
    case 'calc_travel_price': return priceTravel(s,a);
    case 'calc_property_price': return k.products.property.price_per_year_kzt[a.sum_insured]?{price:k.products.property.price_per_year_kzt[a.sum_insured]*(a.property_type==='house'?k.products.property.house_coef:1)}:err('not_eligible','Unsupported sum insured');
    case 'calc_accident_price': return k.products.accident.price_per_year_kzt[a.sum_insured]?{price:k.products.accident.price_per_year_kzt[a.sum_insured]}:err('not_eligible','Unsupported sum insured');
    case 'get_claim': return clone(findClaim(s,a)??err('not_found','Claim'));
    case 'check_payment': {
      const r=s.backend.payments.find(p=>p.client_id===s.client_id&&p.date===a.payment_date);
      return r?{payment_status:r.status,amount:r.amount,policy_number:r.policy_number,note:r.note}:err('not_found','Payment');
    }
    case 'list_clinics': return {clinics:k.clinics.filter(c=>c.city===a.city)};
    case 'get_offices': return clone(k.offices.find(o=>o.city===a.city)??err('not_found','Office'));
    case 'kb_lookup': return knowledge(s,sc,a);
    case 'check_coverage': {
      if (!p) return err('not_found','Policy');
      if (status(p)!=='active') return err('policy_inactive','Policy');
      const pack=k.products.dms.packages[p.details?.package];
      if (p.product!=='dms'||!pack) return err('not_eligible','DMS policy required');
      const t=a.service_name.toLowerCase(); let covered,note;
      if (/имплан|implant|протез|prosthe|космет|cosmet/u.test(t)) covered=false;
      else if (/мрт|mri|(^|\s)кт($|\s)|(^|\s)ct($|\s)/u.test(t)) {
        covered=p.details.package==='Comfort';
        note=covered?tr(s,'МРТ и КТ покрываются по направлению, до двух раз в год.','МРТ мен КТ жолдамамен жылына екі ретке дейін өтеледі.'):tr(s,'МРТ и КТ не входят в Базовую программу.','МРТ мен КТ Базалық бағдарламаға кірмейді.');
      } else if (/терапевт|therapist/u.test(t)) covered=true;
      else if (/стомат|кариес|dental|dentist|тіс/u.test(t)) covered=p.details.package==='Comfort';
      else return err('not_eligible','Coverage needs a specialist');
      return {covered,note:note??(covered?tr(s,'Эта услуга входит в вашу программу; условия указаны в полисе.','Бұл қызмет бағдарламаңызға кіреді; шарттары полисте көрсетілген.'):tr(s,'Эта услуга не входит в вашу программу.','Бұл қызмет бағдарламаңызға кірмейді.')),facts:pack};
    }
    case 'create_policy': {
      const quote=a.product_type==='ogpo'?priceOgpo(s,a):a.product_type==='travel'?priceTravel(s,a):err('not_eligible','Issuance unavailable');
      if (quote.error) return quote;
      if (!a.phone) return err('invalid_input','phone');
      const number=nextId(a.product_type==='ogpo'?'SQ-OGPO-':'SQ-TRVL-',s.backend.policies,'policy_number');
      if (execute) {
        let holder=s.backend.clients.find(c=>c.phone===a.phone);
        if (!holder) {holder={client_id:nextId('C',s.backend.clients,'client_id'),phone:a.phone,full_name:null,preferred_language:s.reply_language};s.backend.clients.push(holder);}
        s.backend.policies.push({policy_number:number,client_id:holder.client_id,product:a.product_type,start_date:a.product_type==='travel'?a.trip_start:TODAY,
          end_date:a.product_type==='travel'?a.trip_end:'2027-09-30',premium:quote.price,status:'pending_payment',details:clone(a)});
      }
      return {policy_number:number,...quote,status:'pending_payment',simulated:true};
    }
    case 'renew_policy': {
      if (!p) return err('not_found','Policy');
      if (p.renewed_to) return err('already_done','Policy renewed');
      if (['cancelled','pending_payment'].includes(status(p))) return err('not_eligible','Policy');
      const start=p.end_date>=TODAY?new Date(Date.parse(p.end_date)+86400000).toISOString().slice(0,10):TODAY;
      const quote=p.product==='ogpo'?priceOgpo(s,p.details):p.product==='casco'?priceCasco(s,p.details,start):err('not_eligible','Renewal pricing unavailable');
      if (quote.error) return quote;
      const number=nextId(p.policy_number.slice(0,-6),s.backend.policies,'policy_number');
      if (execute) {
        const end=new Date(start+'T00:00:00Z');end.setUTCFullYear(end.getUTCFullYear()+1);end.setUTCDate(end.getUTCDate()-1);
        s.backend.policies.push({...clone(p),policy_number:number,premium:quote.price,start_date:start,end_date:end.toISOString().slice(0,10),status:'pending_payment'});
        p.renewed_to=number;
      }
      return {policy_number:number,price:quote.price,status:'pending_payment',simulated:true};
    }
    case 'update_policy': return err('service_unavailable','The dataset does not define amendment extra-premium calculation');
    case 'cancel_policy': {
      if (!p) return err('not_found','Policy');
      if (status(p)==='cancelled') return err('already_done','Policy cancelled');
      if (status(p)!=='active') return err('policy_inactive','Policy');
      if (s.backend.claims.some(c=>c.policy_number===p.policy_number&&c.status==='paid')||!Number.isFinite(p.premium)) return err('not_eligible','Refund is not eligible');
      const end=new Date(p.end_date+'T00:00:00Z');end.setUTCDate(end.getUTCDate()+1);const now=new Date(TODAY);
      const months=Math.max(0,(end.getUTCFullYear()-now.getUTCFullYear())*12+end.getUTCMonth()-now.getUTCMonth()-(end.getUTCDate()<now.getUTCDate()?1:0));
      const refund_amount=Math.round(p.premium*months/12*0.9);
      if(execute){p.status='cancelled';p.cancel_reason=a.cancel_reason;p.refund_amount=refund_amount;}
      return {refund_amount,simulated:true};
    }
    case 'update_contact': {
      if(!c)return err('not_found','Client');
      if(!['phone','email','address'].includes(a.contact_field))return err('invalid_input','contact_field');
      let value=a.new_value;
      if(['phone','email'].includes(a.contact_field)){
        const validated=normalize(s.data.slots.slots.find(d=>d.name===a.contact_field),value);
        if(validated.error)return err('invalid_input','new_value');value=validated.value;
      }
      if(a.contact_field==='phone'&&s.backend.clients.some(x=>x.client_id!==c.client_id&&x.phone===value))return err('invalid_input','Phone already assigned');
      if(execute){c[a.contact_field]=value;if(a.contact_field==='phone')s.identity.phone=value;}
      return {updated_field:a.contact_field,simulated:true};
    }
    case 'create_claim': {
      if(!p)return err('not_found','Policy');
      if(a.incident_date>TODAY||a.incident_date<p.start_date||a.incident_date>p.end_date||p.status==='cancelled')return err('policy_inactive','Policy on incident date');
      const number=nextId('CL-',s.backend.claims,'claim_number');
      if(execute){
        let owner=a.phone?s.backend.clients.find(x=>x.phone===a.phone):c;
        if(!owner&&sc.scenario_id==='SC12'){owner={client_id:nextId('C',s.backend.clients,'client_id'),phone:a.phone,full_name:null};s.backend.clients.push(owner);}
        if(!owner)return err('not_found','Claimant');
        s.backend.claims.push({claim_number:number,client_id:owner.client_id,policy_number:p.policy_number,claim_type:sc.scenario_id==='SC12'?'ogpo_victim':p.product,
          incident_date:a.incident_date,incident_description:a.incident_description,status:'registered',next_step:k.claims.submission});
      }
      return {claim_number:number,simulated:true};
    }
    case 'create_dispute': {
      if(!findClaim(s,a))return err('not_found','Claim');
      const ticket_id=nextId('T-',s.journal,'ticket_id');
      if(execute)s.journal.push({ticket_id,name,claim_number:a.claim_number,complaint_text:a.complaint_text,simulated:true});
      return {ticket_id,simulated:true};
    }
    case 'book_inspection':case 'book_appointment':return err('no_availability','No booking calendar is supplied; an operator must confirm availability');
    case 'resend_documents':case 'request_document':{
      if(!p)return err('not_found','Policy');const to=a.email??c?.email??c?.phone;
      if(!to)return err('invalid_input','email');
      if(execute)s.journal.push({name,policy_number:p.policy_number,sent_to:to,document_type:a.document_type,simulated:true});
      return {sent_to:mask(to),simulated:true};
    }
    case 'send_sms':{
      const to=a.phone??c?.phone;if(!to)return {skipped:true};
      if(execute)s.journal.push({name,phone:to,simulated:true});return {sent_to:mask(to),simulated:true};
    }
    case 'create_callback':case 'create_complaint':case 'report_fraud':{
      const ticket_id=nextId('T-',s.journal,'ticket_id');
      if(execute)s.journal.push({ticket_id,name,args:clone(a),simulated:true});return {ticket_id,simulated:true};
    }
    case 'transfer_to_operator':{
      const queue=sc.handoff?.queue??'operator_general';
      if(!s.data.actions.queues.includes(queue))return err('invalid_input','queue');
      return {queue,simulated:true};
    }
    default:return err('service_unavailable','Operation is not implemented');
  }
}
function errorReply(s,r) {
  if(r.error?.code==='not_found'&&Array.isArray(r.sources)&&typeof r.answer==='string')return r.answer;
  const texts={
    not_found:['В данных нет подходящего результата; проверьте идентификатор или обратитесь к оператору.','Деректерден сәйкес нәтиже табылмады; нөмірді тексеріңіз немесе операторға хабарласыңыз.'],
    policy_inactive:['Полис не действует на нужную дату; операцию выполнить нельзя.','Полис қажетті күнге жарамсыз; операцияны орындау мүмкін емес.'],
    not_eligible:['Правила или данные не позволяют выполнить этот запрос автоматически; нужна помощь оператора.','Ереже не дерек бұл сұранысты автоматты орындауға мүмкіндік бермейді; оператор көмегі керек.'],
    already_done:['Эта операция уже выполнена; повторно её не выполняю.','Бұл операция орындалған; қайта орындамаймын.'],
    no_availability:['В данных нет подтверждённого свободного времени; запись должен согласовать оператор.','Деректерде расталған бос уақыт жоқ; қабылдау уақытын оператор келісуі керек.'],
    service_unavailable:['Для этой операции в данных недостаточно правил; нужна помощь оператора.','Бұл операцияға деректердегі ереже жеткіліксіз; оператор көмегі керек.'],
    invalid_input:['Нужно уточнить данные запроса.','Сұраныс деректерін нақтылау керек.']};
  return tr(s,...(texts[r.error?.code]??texts.service_unavailable));
}
function identify(s,sc,slots,incoming) {
  const supplied=['phone','iin'].filter(k=>has(incoming[k]));let found;
  if(supplied.length){
    const matches=supplied.map(k=>s.backend.clients.find(c=>c[k]===incoming[k]));
    if(matches.some(x=>!x)||new Set(matches.map(c=>c.client_id)).size>1){
      s.client_id=null;s.identity={};
      if(sc.requires_identification)return err('not_found','Identity');
    }else found=matches[0];
  }
  if(!found&&!s.client_id&&!supplied.length&&sc.requires_identification){
    const claim=slots.claim_number&&s.backend.claims.find(c=>c.claim_number===slots.claim_number);
    const policy=slots.policy_number&&s.backend.policies.find(p=>p.policy_number===slots.policy_number);
    found=s.backend.clients.find(c=>c.client_id===(claim?.client_id??policy?.client_id));
  }
  if(found){
    if(s.client_id&&s.client_id!==found.client_id){s.scenario_slots={[sc.scenario_id]:clone(incoming)};slots=s.scenario_slots[sc.scenario_id];s.pending_confirmation=null;s.queued_scenarios=[];s.suspended_scenarios=[];}
    s.client_id=found.client_id;s.identity={phone:found.phone,...(found.iin?{iin:found.iin}:{})};
  }
  if(sc.requires_identification&&!s.client_id)return {missing:'phone'};
  const c=customer(s);
  if(c&&sc.requires_identification){
    for(const key of ['phone','iin','city','email'])if(!has(slots[key])&&has(c[key]))slots[key]=c[key];
    if(slots.policy_number&&!findPolicy(s,slots))return err('not_found','Policy does not belong to client');
    if(slots.claim_number&&!findClaim(s,slots))return err('not_found','Claim does not belong to client');
    if(!slots.policy_number&&(sc.slots.required.includes('policy_number')||sc.scenario_id==='SC26')){
      const product=({SC13:'casco',SC14:'property',SC15:'travel',SC16:'accident',SC21:'dms',SC22:'dms',SC24:'dms'})[sc.scenario_id];
      const matches=s.backend.policies.filter(p=>p.client_id===c.client_id&&(!product||p.product===product));
      if(matches.length===1)slots.policy_number=matches[0].policy_number;
    }
    if(!slots.claim_number&&sc.slots.required.includes('claim_number')){
      const matches=s.backend.claims.filter(c=>c.client_id===s.client_id);if(matches.length===1)slots.claim_number=matches[0].claim_number;
    }
  }
  return {slots};
}
function transfer(sc,a,r,text) {
  switch(sc.scenario_id){
    case 'SC10':case 'SC15':case 'SC37':return true;
    case 'SC11':return a.injured===true;
    case 'SC13':return /угон|украл|украден|ұрла|ұрлан|theft|total loss/iu.test(a.incident_description??'');
    case 'SC14':return /пострадав|ранен|зардап|жарақат/iu.test(a.incident_description??'');
    case 'SC30':return r.payment_status==='charged_policy_not_issued';
    case 'SC35':return /оператор|адаммен|маманмен/iu.test(text);
    case 'SC38':return /сообщил|сообщила|передал|передала|назвал|назвала|жібердім|айттым|бердім/iu.test(a.fraud_details??'');
    default:return false;
  }
}
function closing(s,sc,a,r) {
  const id=sc.scenario_id;
  if(['SC01','SC03','SC07','SC08'].includes(id))return sc.responses[s.reply_language].closing.replace(/\{price\}/g,String(r.price));
  if(id==='SC25'){
    const labels={active:['действует','жарамды'],expired:['истёк','мерзімі өткен'],not_started:['ещё не действует','әлі басталмаған'],cancelled:['расторгнут','бұзылған'],pending_payment:['ожидает оплаты','төлем күтілуде']};
    return tr(s,'Полис ','Полис ')+a.policy_number+': '+tr(s,...(labels[r.status]??[r.status,r.status]))+tr(s,', срок до ', ', мерзімі ')+r.end_date+'.';
  }
  if(id==='SC17'){
    const labels={paid:['выплачено','төленді'],approved:['одобрено','мақұлданды'],documents_requested:['ожидаются документы','құжаттар күтілуде'],under_review:['на рассмотрении','қаралып жатыр'],registered:['зарегистрировано','тіркелді']};
    let reply=tr(s,'Заявление ','Өтініш ')+r.claim_number+': '+tr(s,...(labels[r.status]??[r.status,r.status]))+'.';
    if(r.approved_amount)reply+=tr(s,' Сумма: ',' Сома: ')+r.approved_amount+tr(s,' тенге.',' теңге.');
    if(r.decision_due)reply+=tr(s,' Решение ожидается до ',' Шешім мерзімі: ')+r.decision_due+'.';
    if(r.status==='documents_requested')reply+=tr(s,' Нужен акт управляющей компании.',' Басқарушы компанияның актісі керек.');
    return reply;
  }
  if(id==='SC22')return r.note;
  if(id==='SC23')return r.clinics?.length?tr(s,'Клиники: ','Емханалар: ')+r.clinics.map(c=>c.name+', '+c.address).join('; ')+'.':tr(s,'В данных нет подходящей клиники; поможет оператор.','Деректерде сәйкес емхана жоқ; оператор көмектеседі.');
  if(id==='SC33')return tr(s,'Офис: ','Кеңсе: ')+r.address+'. '+tr(s,'Режим: ','Жұмыс уақыты: ')+r.hours+'.';
  if(id==='SC32')return tr(s,'Ваш класс бонус-малус: ','Бонус-малус сыныбыңыз: ')+r.bm_class+'. '+r.answer;
  if(id==='SC30')return tr(s,'Платёж: ','Төлем: ')+r.amount+tr(s,' тенге; ',' теңге; ')+(r.payment_status==='charged_policy_not_issued'?tr(s,'деньги списаны, полис не выпущен. В демо передан контекст оператору.','ақша алынған, полис шықпаған. Демода мәлімет операторға берілді.'):tr(s,'статус: ','күйі: ')+r.payment_status+'.');
  if(['SC02','SC06','SC27'].includes(id))return tr(s,'В демо создан полис ','Демода полис жасалды: ')+r.policy_number+tr(s,', стоимость ',', бағасы ')+r.price+tr(s,' тенге; ожидает оплаты.',' теңге; төлем күтілуде.');
  if(id==='SC28')return tr(s,'В демо полис расторгнут; расчёт возврата — ','Демода полис бұзылды; қайтарым есебі — ')+r.refund_amount+tr(s,' тенге.',' теңге.');
  if(id==='SC29')return tr(s,'Контактные данные обновлены в демо.','Байланыс деректері демода жаңартылды.');
  if(['SC12','SC13','SC14','SC16'].includes(id))return tr(s,'В демо зарегистрировано заявление ','Демода өтініш тіркелді: ')+r.claim_number+'.';
  if(id==='SC19')return tr(s,'В демо зарегистрировано несогласие ','Демода келіспеу өтініші тіркелді: ')+r.ticket_id+tr(s,'; по правилам рассмотрение занимает 15 рабочих дней.','; ереже бойынша 15 жұмыс күні ішінде қаралады.');
  if(id==='SC35')return tr(s,'В демо зарегистрирована жалоба ','Демода шағым тіркелді: ')+r.ticket_id+'.';
  if(id==='SC36')return tr(s,'В демо записан запрос обратного звонка: ','Демода кері қоңырау сұранысы жазылды: ')+a.callback_time+'.';
  if(['SC26','SC39'].includes(id))return tr(s,'В демо зарегистрирована отправка документа на ','Демода құжат жіберу тіркелді: ')+r.sent_to+'.';
  if(['SC10','SC15','SC37'].includes(id))return tr(s,'В демо передан контекст в очередь ','Демода мәлімет кезекке берілді: ')+r.queue+tr(s,'; реальное соединение здесь не выполняется.','; мұнда нақты операторға қосылу орындалмайды.');
  if(id==='SC18')return tr(s,'Нужны: ','Керек құжаттар: ')+r.answer+'.';
  return r.answer||tr(s,'Запрос обработан в демо.','Сұраныс демода өңделді.');
}
function previewReply(s,sc,args,r) {
  const fields=[...new Set([...sc.slots.required,'product_type'])].filter(k=>has(args[k]));
  const labels={phone:['телефон','телефон'],policy_number:['полис','полис'],claim_number:['заявление','өтініш'],new_value:['новое значение','жаңа мән'],contact_field:['контакт','байланыс'],cancel_reason:['причина','себеп'],incident_description:['описание','сипаттама'],incident_date:['дата события','оқиға күні'],complaint_text:['обращение','өтініш'],vehicle_plate:['госномер','мемлекеттік нөмір'],drivers_iin:['ИИН водителей','жүргізушілер ЖСН'],trip_country:['страна','ел'],trip_start:['начало','басталуы'],trip_end:['окончание','аяқталуы'],travelers_count:['путешественники','саяхатшылар'],traveler_max_age:['возраст','жас'],product_type:['продукт','өнім']};
  const details=fields.map(k=>tr(s,...(labels[k]??[k,k]))+': '+mask(Array.isArray(args[k])?args[k].join(', '):args[k])).join('; ');
  const quote=r.price!==undefined?tr(s,'; стоимость ','; бағасы ')+r.price:r.refund_amount!==undefined?tr(s,'; возврат ','; қайтарым ')+r.refund_amount:'';
  return tr(s,'Подтвердите действие: ','Әрекетті растаңыз: ')+details+quote+'. '+tr(s,'Всё верно?','Бәрі дұрыс па?');
}
export function processTurn(s,decision,{turnId,transcript=''}={}) {
  const key=String(turnId??s.turn+1);if(s.turns.has(key))return clone(s.turns.get(key));s.turn++;
  const oldPending=clone(s.pending_confirmation),oldActive=s.active_scenario,oldStatus=s.status;
  let actions=[],scenarios=[],alternatives=[],incoming={},validation=[];
  const finish=(reply,newStatus=s.status,handoffReason=null)=>{
    if(newStatus==='handoff'&&!actions.some(action=>action.name==='transfer_to_operator')) {
      actions.push({name:'transfer_to_operator',mode:'execute',result:{queue:'operator_general',simulated:true}});
    }
    actions=actions.map((action,index)=>{
      if(action.name!=='transfer_to_operator'||action.result?.error)return action;
      const preceding=actions.slice(0,index);
      const failed=preceding.filter(item=>item.result?.error).at(-1);
      const reason=handoffReason??(failed?'action_failed:'+failed.result.error.code:scenarios[0]?.scenario_id==='SC37'?'customer_requested':'scenario_handoff');
      const result={...action.result,context:handoffContext(s,{reason,transcript,actions:preceding,priorConfirmation:oldPending,turnId:key})};
      if(!action.deduplicated)s.journal.push({name:action.name,...clone(result),turn_id:key});
      return {...action,result};
    });
    s.status=newStatus;s.last_reply=mask(reply);
    s.last_decision={scenarios,alternatives,language:s.language,slots:incoming,is_continuation:Boolean(decision?.is_continuation)};
    const trace={turn:s.turn,turn_id:key,transcript:String(transcript),language:s.language,scenarios,alternatives,reason:scenarios[0]?.reason??'',
      slots:clone(s.scenario_slots[s.active_scenario]??{}),actions:clone(actions),confirmation:clone(s.pending_confirmation),active_scenario:s.active_scenario,
      queued_scenarios:[...s.queued_scenarios],suspended_scenarios:[...s.suspended_scenarios],status:newStatus,validation_errors:validation};
    const result={reply:s.last_reply,trace,state:state(s)};s.turns.set(key,clone(result));return result;
  };
  const catalog=new Map(s.data.scenarios.scenarios.map(x=>[x.scenario_id,x])),system=new Map(s.data.scenarios.system_intents.map(x=>[x.id,x]));
  const known=id=>catalog.has(id)||system.has(id);
  if(!decision||!Array.isArray(decision.scenarios)||!decision.scenarios.length||decision.scenarios.some(x=>!known(x?.scenario_id)||!Number.isFinite(x.confidence)||x.confidence<0||x.confidence>1)){
    s.pending_confirmation=null;scenarios=[{scenario_id:'SYS_UNCLEAR',confidence:0,reason:'Invalid router result'}];
    return finish(tr(s,'Не удалось надёжно определить запрос. Уточните, что нужно сделать?','Сұраныс анықталмады. Не істеу керегін нақтылаңыз.'),'clarification');
  }
  if(['ru','kk','mixed'].includes(decision.language))s.language=decision.language;
  if(s.language!=='mixed')s.reply_language=s.language;else if(/[әіңғүұқөһ]/iu.test(transcript))s.reply_language='kk';
  scenarios=decision.scenarios.filter((x,i,a)=>a.findIndex(v=>v.scenario_id===x.scenario_id)===i).map(x=>({scenario_id:x.scenario_id,confidence:x.confidence,reason:String(x.reason??'').slice(0,500)}));
  scenarios.sort((a,b)=>Number(catalog.get(b.scenario_id)?.priority==='urgent')-Number(catalog.get(a.scenario_id)?.priority==='urgent'));
  alternatives=Array.isArray(decision.alternatives)?decision.alternatives.filter(x=>known(x?.scenario_id)&&Number.isFinite(x.confidence)&&x.confidence>=0&&x.confidence<=1).map(x=>({scenario_id:x.scenario_id,confidence:x.confidence})):[];
  const definitions=new Map(s.data.slots.slots.map(d=>[d.name,d]));
  if(decision.slots&&typeof decision.slots==='object'&&!Array.isArray(decision.slots)){
    for(const [name,value]of Object.entries(decision.slots)){
      if(['__proto__','constructor','prototype'].includes(name)||!definitions.has(name)){validation.push({field:name,code:'unknown_slot'});continue;}
      const n=normalize(definitions.get(name),value);if(n.error)validation.push({field:name,code:'invalid_input'});else incoming[name]=n.value;
    }
  }
  const chosen=scenarios[0].scenario_id;
  if(system.has(chosen)){
    s.pending_confirmation=null;
    if(chosen==='SYS_GOODBYE'){s.active_scenario=null;s.queued_scenarios=[];s.suspended_scenarios=[];}
    return finish(chosen==='SYS_UNCLEAR'?tr(s,'Уточните, пожалуйста, что нужно сделать со страховкой?','Сақтандыру бойынша не істеу керегін нақтылаңыз.'):system.get(chosen).response[s.reply_language],chosen==='SYS_GOODBYE'?'closed':'clarification');
  }
  if(scenarios[0].confidence<0.75){
    s.pending_confirmation=null;s.low_confidence_count=scenarios[0].confidence<0.45?s.low_confidence_count+1:0;
    if(s.low_confidence_count>=2){actions.push({name:'transfer_to_operator',mode:'execute',result:{queue:'operator_general',simulated:true}});return finish(tr(s,'Не удалось уточнить запрос; в демо передаю контекст оператору.','Сұраныс анықталмады; демода мәліметті операторға беремін.'),'handoff','low_confidence');}
    return finish(tr(s,'Уточните, что хотите сделать со страховкой?','Сақтандыру бойынша не істегіңіз келетінін нақтылаңыз.'),'clarification');
  }
  s.low_confidence_count=0;
  if(oldActive&&oldActive!==chosen&&!s.completed.has(oldActive)&&!s.suspended_scenarios.includes(oldActive))s.suspended_scenarios.push(oldActive);
  if(oldActive!==chosen)s.pending_confirmation=null;
  s.active_scenario=chosen;s.suspended_scenarios=s.suspended_scenarios.filter(id=>id!==chosen);
  s.queued_scenarios=[...new Set([...scenarios.slice(1).map(x=>x.scenario_id).filter(id=>catalog.has(id)),...s.queued_scenarios])].filter(id=>id!==chosen);
  const sc=catalog.get(chosen);let slots=s.scenario_slots[chosen]??={},changed=false;
  // Preserve scenario-local slot maps; distribute fields of additional intents without leaking them into the active operation.
  for(const [field,value]of Object.entries(incoming)){
    let targets=scenarios.filter(x=>catalog.has(x.scenario_id)).map(x=>catalog.get(x.scenario_id)).filter(x=>[...x.slots.required,...x.slots.optional,'phone','iin','product_type'].includes(field));
    if(!targets.length){validation.push({field,code:'slot_not_for_scenario'});continue;}
    if(['phone','iin'].includes(field))targets=[sc];
    for(const target of targets){
      const map=s.scenario_slots[target.scenario_id]??={};
      if(target.scenario_id===chosen&&has(map[field])&&stable(map[field])!==stable(value))changed=true;
      map[field]=value;
    }
  }
  slots=s.scenario_slots[chosen];
  if(changed||validation.length)s.pending_confirmation=null;
  if(changed)s.completed.delete(chosen);
  if(validation.length)return finish(tr(s,'Проверьте данные. ','Деректерді тексеріңіз. ')+ask(s,definitions.has(validation[0].field)?validation[0].field:sc.slots.required[0]),'invalid_input');
  if(oldStatus==='completed'&&oldActive===chosen&&decision.confirmation==='confirm'&&yes(transcript)&&!Object.keys(incoming).length){
    actions.push({name:'confirmation',mode:'read',result:{already_done:true}});
    return finish(s.last_reply,'completed');
  }
  const activeIncoming=Object.fromEntries(Object.entries(incoming).filter(([field])=>[...sc.slots.required,...sc.slots.optional,'phone','iin','product_type'].includes(field)));
  const ident=identify(s,sc,slots,activeIncoming);
  if(ident.error){s.pending_confirmation=null;actions.push({name:'find_client',mode:'read',result:ident});return finish(errorReply(s,ident),'identification');}
  if(ident.missing)return finish(ask(s,ident.missing),'identification');slots=ident.slots;
  const p=findPolicy(s,slots,chosen==='SC12'),expected=({SC13:'casco',SC14:'property',SC15:'travel',SC16:'accident',SC21:'dms',SC22:'dms'})[chosen];
  if(p&&expected&&p.product!==expected){s.pending_confirmation=null;return finish(tr(s,'Нужен другой вид полиса. ','Басқа полис түрі керек. ')+ask(s,'policy_number'),'invalid_input');}
  if(p)slots.product_type??=p.product;
  if(chosen==='SC02')slots.product_type='ogpo';if(chosen==='SC06')slots.product_type='travel';if(chosen==='SC12')slots.product_type='ogpo';if(chosen==='SC03')slots.franchise??=0;
  const missing=sc.slots.required.find(k=>!has(slots[k]));
  if(missing){s.pending_confirmation=null;return finish((['SC11','SC38'].includes(chosen)?sc.responses[s.reply_language].opening+' ':'')+ask(s,missing),'collecting_slots');}
  for(const extra of (chosen==='SC02'?['vehicle_type']:chosen==='SC06'?['phone']:chosen==='SC26'?['policy_number']:chosen==='SC40'?['product_type']:[]))if(!has(slots[extra]))return finish(ask(s,extra),'collecting_slots');
  if(oldPending&&oldPending.scenario_id===chosen&&(decision.confirmation==='reject'||no(transcript))){s.pending_confirmation=null;s.operation_context=null;return finish(tr(s,'Действие отменено. Что нужно изменить?','Әрекет тоқтатылды. Нені өзгерту керек?'),'cancelled');}
  const args={...clone(slots),...(s.client_id?{client_id:s.client_id}:{})};let results={},handedOff=false;
  const argsKey=stable({scenario:chosen,args}),previousOperation=s.operation_context;
  // Retry results belong to one request and its confirmation, not every future request with the same values.
  if(!previousOperation||previousOperation.args_key!==argsKey||oldActive!==chosen||changed||
    (previousOperation.finished&&!(decision.confirmation==='confirm'&&yes(transcript)))){
    s.operation_context={id:randomUUID(),args_key:argsKey,finished:false};
  }
  for(const name of sc.actions){
    const def=s.data.actions.actions.find(x=>x.name===name);
    if(!def){const result=err('service_unavailable',name);actions.push({name,mode:'read',result});return finish(errorReply(s,result),'handoff');}
    if(name==='transfer_to_operator'&&!transfer(sc,args,results,transcript))continue;
    if(name==='find_client'&&!sc.requires_identification)continue;
    if(name==='get_bm_class'&&!args.iin&&!args.new_driver_iin&&!args.drivers_iin)continue;
    if(name==='send_sms'&&!args.phone&&!customer(s)?.phone)continue;
    const operationKey=stable({operation_id:s.operation_context.id,scenario:chosen,name,args});
    if(def.irreversible){
      const previous=s.operations.get(operationKey);
      if(previous){actions.push({name,mode:'execute',args:clone(args),result:clone(previous),deduplicated:true});Object.assign(results,previous);continue;}
      const preview=runAction(s,sc,name,args,false);
      if(preview.error){
        s.pending_confirmation=null;actions.push({name,mode:'preview',args:clone(args),result:preview});
        actions.push({name:'transfer_to_operator',mode:'execute',result:{queue:sc.handoff?.queue??'operator_general',simulated:true}});
        return finish(errorReply(s,preview),'handoff');
      }
      const confirmed=!changed&&oldActive===chosen&&s.pending_confirmation&&oldPending?.operation_key===operationKey&&oldPending.preview_turn<s.turn&&decision.confirmation==='confirm'&&yes(transcript);
      if(!confirmed){
        s.pending_confirmation={operation_id:oldPending?.operation_key===operationKey?oldPending.operation_id:randomUUID(),operation_key:operationKey,scenario_id:chosen,name,args:clone(args),result:clone(preview),preview_turn:s.turn};
        actions.push({name,mode:'preview',args:clone(args),result:preview});return finish(previewReply(s,sc,args,preview),'awaiting_confirmation');
      }
      const result=runAction(s,sc,name,args,true);s.pending_confirmation=null;actions.push({name,mode:'execute',args:clone(args),result});
      if(result.error)return finish(errorReply(s,result),'action_error');s.operations.set(operationKey,clone(result));Object.assign(results,result);
    }else{
      const effect=['send_sms','resend_documents','request_document','create_callback','create_complaint','report_fraud','transfer_to_operator'].includes(name);
      const previous=effect&&s.operations.get(operationKey),result=previous||runAction(s,sc,name,args,effect);
      actions.push({name,mode:effect?'execute':'read',args:clone(args),result:clone(result),...(previous?{deduplicated:true}:{})});
      if(result.error){
        if(chosen==='SC12'&&name==='get_policy'&&result.error.code==='not_found'){
          s.pending_confirmation=null;
          actions.push({name:'transfer_to_operator',mode:'execute',result:{queue:'operator_general',simulated:true}});
          return finish(errorReply(s,result),'handoff');
        }
        return finish(errorReply(s,result),'action_error');
      }
      if(effect)s.operations.set(operationKey,clone(result));if(name==='transfer_to_operator')handedOff=true;Object.assign(results,result);
    }
  }
  s.operation_context.finished=true;
  s.completed.add(chosen);s.pending_confirmation=null;let reply=closing(s,sc,args,results);
  if(s.queued_scenarios.length)reply+=tr(s,' Остальные вопросы тоже сохранены.',' Қалған сұрақтар да сақталды.');
  else if(s.suspended_scenarios.length)reply+=tr(s,' Можем вернуться к предыдущему вопросу.',' Алдыңғы сұраққа оралуға болады.');
  return finish(reply,handedOff?'handoff':'completed');
}
