// Structured policy facts from the organizer knowledge base. This is not semantic search.
const choose = (language, ru, kk) => language === 'kk' ? kk : ru;
const terms = {
  'Driving under the influence': ['управление в состоянии опьянения', 'мас күйінде көлік жүргізу'],
  'Driver not listed in the policy': ['водитель, не указанный в полисе', 'полисте көрсетілмеген жүргізуші'],
  'Intentional damage': ['умышленный ущерб', 'қасақана келтірілген зиян'],
  'Wear and tear, mechanical breakdown': ['износ и механические поломки', 'тозу және механикалық ақаулар'],
  'Using the car as a taxi unless declared': ['работа в такси, если она не заявлена', 'мәлімделмеген такси қызметі'],
  'Damage due to unauthorized reconstruction': ['ущерб из-за несогласованной перепланировки', 'рұқсатсыз қайта жоспарлаудан болған зиян'],
  'Wear and tear': ['износ', 'тозу'],
  'Professional sports': ['профессиональный спорт', 'кәсіби спорт'],
  'Intoxication': ['опьянение', 'мас болу'],
  'Self-harm': ['самоповреждение', 'өзіне зиян келтіру'],
  'Illness (not an accident)': ['болезнь, не связанная с несчастным случаем', 'жазатайым оқиғаға байланысты емес ауру'],
  'Damage the driver causes to other people\'s health and property in a road accident. Own car is not covered.': ['вред здоровью и имуществу других людей при ДТП; собственный автомобиль не покрывается', 'ЖКО кезінде басқа адамдардың денсаулығы мен мүлкіне келтірілген зиян; өз көлігіңіз қамтылмайды'],
  'Damage in accidents (any fault), theft, total loss, natural disasters, falling objects, vandalism.': ['ущерб при ДТП независимо от виновника, угон, полная гибель, стихийные бедствия, падение предметов и вандализм', 'кінәлі тарапқа қарамастан ЖКО зақымы, ұрлық, толық жойылу, табиғи апаттар, заттардың құлауы және вандализм'],
  'Theft and total loss only.': ['только угон и полная гибель', 'тек ұрлық және толық жойылу'],
  'Fire, water damage, theft, natural disasters, liability to neighbours.': ['пожар, затопление, кража, стихийные бедствия и ответственность перед соседями', 'өрт, су басу, ұрлық, табиғи апаттар және көршілер алдындағы жауапкершілік'],
  'Injuries and disability caused by an accident, 24/7 worldwide, including sports at amateur level.': ['травмы и инвалидность вследствие несчастного случая, круглосуточно по всему миру, включая любительский спорт', 'жазатайым оқиғадан болған жарақат пен мүгедектік, бүкіл әлемде тәулік бойы, әуесқой спортты қоса'],
  'Therapist visits': ['приём терапевта', 'терапевт қабылдауы'],
  'Specialists by therapist referral': ['специалисты по направлению терапевта', 'терапевт жолдамасымен мамандар'],
  'Basic lab tests by referral': ['базовые анализы по направлению', 'жолдамамен негізгі талдаулар'],
  'Emergency care': ['неотложная помощь', 'шұғыл көмек'],
  'Emergency hospitalization': ['экстренная госпитализация', 'шұғыл ауруханаға жатқызу'],
  'MRI and CT': ['МРТ и КТ', 'МРТ және КТ'],
  'Dentistry': ['стоматология', 'стоматология'],
  'Planned hospitalization': ['плановая госпитализация', 'жоспарлы ауруханаға жатқызу'],
  'Outpatient medications': ['амбулаторные лекарства', 'амбулаторлық дәрілер'],
  'Specialists without referral (ENT, cardiologist, gynecologist, etc.)': ['специалисты без направления, включая ЛОРа, кардиолога и гинеколога', 'жолдамасыз мамандар, оның ішінде ЛОР, кардиолог және гинеколог'],
  'Lab tests by doctor\'s referral': ['анализы по направлению врача', 'дәрігер жолдамасымен талдаулар'],
  'Ultrasound': ['УЗИ', 'УДЗ'],
  'MRI and CT by referral, up to 2 per year': ['МРТ и КТ по направлению до двух раз в год', 'жолдамамен МРТ және КТ жылына екі ретке дейін'],
  'Dental treatment (caries, extraction)': ['лечение кариеса и удаление зубов', 'тісжегіні емдеу және тісті жұлу'],
  'Emergency and planned hospitalization': ['экстренная и плановая госпитализация', 'шұғыл және жоспарлы ауруханаға жатқызу'],
  'Medications during hospitalization': ['лекарства во время госпитализации', 'ауруханада жатқан кездегі дәрілер'],
  'Dental prosthetics and implants': ['зубные протезы и импланты', 'тіс протездері мен импланттары'],
  'Cosmetology': ['косметология', 'косметология'],
};
const packageNames = { Standard: ['Стандарт', 'Стандарт'], Lite: ['Лайт', 'Лайт'], Basic: ['Базовая', 'Базалық'], Comfort: ['Комфорт', 'Комфорт'] };
const pointer = parts => 'knowledge_base.json#/' + parts.map(x => String(x).replaceAll('~', '~0').replaceAll('/', '~1')).join('/');
const plainNumber = value => typeof value === 'number' && Number.isFinite(value);

export function lookupPolicyKnowledge(knowledge, { product_type: productId, topic }, language = 'ru') {
  const product = knowledge.products?.[productId];
  const q = String(topic ?? '').normalize('NFKC').toLowerCase().replaceAll('ё', 'е');
  const missing = () => ({ error: { code: 'not_found', message: 'No supported fact for this policy topic' }, sources: [],
    answer: choose(language, 'В базе знаний нет точного ответа на этот вопрос. Уточните тему или обратитесь к оператору.', 'Білім базасында бұл сұраққа нақты жауап жоқ. Тақырыпты нақтылаңыз немесе операторға жүгініңіз.') });
  if (!product || !q.trim()) return missing();
  const entries = [];
  const fact = (parts, value) => { entries.push({ path: pointer(['products', productId, ...parts]), value: structuredClone(value) }); return value; };
  const translated = value => terms[value]?.[language === 'kk' ? 1 : 0];
  const textList = value => {
    const list = Array.isArray(value) ? value : [value];
    const text = list.map(translated);
    return text.length && text.every(Boolean) ? text.join(', ') : null;
  };
  const packageName = name => packageNames[name]?.[language === 'kk' ? 1 : 0] ?? name;
  const requestedPackage = /lite|лайт/u.test(q) ? 'Lite' : /standard|стандарт/u.test(q) ? 'Standard' : /comfort|комфорт/u.test(q) ? 'Comfort' : /basic|базов|базал/u.test(q) ? 'Basic' : null;
  const packages = object => Object.entries(object ?? {}).filter(([name]) => !requestedPackage || name === requestedPackage);
  let answer;
  if (/возраст|скольк[^.?!]*лет|(?<!\p{L})(?:жас(?:ы|ын|ына|ынан|тағы|қа|тан|та)?|age)(?!\p{L})/u.test(q) && /авто|машин|көлік|car|vehicle/u.test(q)) {
    if (productId !== 'casco') return missing();
    const values = packages(product.pricing?.max_car_age);
    if (!values.length || values.some(([, value]) => !plainNumber(value))) return missing();
    answer = choose(language, 'Максимальный возраст автомобиля: ', 'Көліктің ең жоғары жасы: ') + values.map(([name, value]) => {
      fact(['pricing', 'max_car_age', name], value);
      return packageName(name) + ' — ' + value + choose(language, ' лет', ' жыл');
    }).join('; ') + '.';
  } else if (/франшиз|deductible/u.test(q)) {
    // The dataset lists deductible amounts but does not define the term itself.
    const asksDefinition = /что (?:такое|значит|означает)|деген(?:іміз)?\s+не|what is|определен|объясн|түсіндір|анықтама|мағын/u.test(q);
    const asksAmount = /размер|сумм|вариант|сколько|мөлшер|нұсқа|қанша|amount|options|how much/u.test(q);
    if (productId !== 'casco' || asksDefinition || !asksAmount) return missing();
    const amounts = Object.keys(product.pricing?.franchise_coef ?? {});
    if (!amounts.length || amounts.some(x => !/^\d+$/u.test(x))) return missing();
    fact(['pricing', 'franchise_coef'], product.pricing.franchise_coef);
    answer = choose(language, 'В базе указаны варианты франшизы: ', 'Базадағы франшиза нұсқалары: ') + amounts.join(', ') + choose(language, ' тенге.', ' теңге.');
  } else if (/исключ|(?<!\p{L})не\s*(?:покры|оплач|плат|выплач)|өте(?:л)?мей|қамты(?:л)?май|төленбе|төлем[^.?!]*жаса(?:л)?ма|exclusion|not covered/u.test(q)) {
    if (productId === 'dms') {
      const values = packages(product.packages);
      const text = values.map(([name, value]) => {
        const items = textList(value.not_covered);
        if (!items) return null;
        fact(['packages', name, 'not_covered'], value.not_covered);
        return packageName(name) + ': ' + items;
      });
      if (!text.length || text.some(x => !x)) return missing();
      answer = choose(language, 'Не покрываются — ', 'Өтелмейді — ') + text.join('; ') + '.';
    } else if (product.exclusions) {
      const text = textList(product.exclusions);
      if (!text) return missing();
      fact(['exclusions'], product.exclusions);
      answer = choose(language, 'Исключения: ', 'Ерекшеліктер: ') + text + '.';
    } else if (productId === 'ogpo' && translated(product.covers)) {
      fact(['covers'], product.covers); answer = translated(product.covers) + '.';
    } else return missing();
  } else if (/лимит|шек|limit/u.test(q)) {
    if (productId !== 'travel') return missing();
    const values = Object.entries(product.zones ?? {});
    if (!values.length || values.some(([, zone]) => typeof zone.coverage !== 'string' || !/^\d[\d ]* (USD|EUR)$/u.test(zone.coverage))) return missing();
    answer = choose(language, 'Лимиты по зонам: ', 'Аймақтар бойынша лимиттер: ') + values.map(([name, zone]) => {
      fact(['zones', name, 'coverage'], zone.coverage); return name + ' — ' + zone.coverage;
    }).join('; ') + '.';
  } else if (/срок|мерзім|duration|term/u.test(q)) {
    if (!Array.isArray(product.terms_months) || !product.terms_months.length || !product.terms_months.every(plainNumber)) return missing();
    fact(['terms_months'], product.terms_months);
    answer = choose(language, 'Доступный срок: ', 'Қолжетімді мерзім: ') + product.terms_months.join(choose(language, ' или ', ' немесе ')) + choose(language, ' месяцев.', ' ай.');
  } else if (/покры|что входит|қамт|өтей|coverage|covers|пакет|бағдарлам/u.test(q)) {
    if (product.covers) {
      const text = textList(product.covers);
      if (!text) return missing();
      fact(['covers'], product.covers); answer = choose(language, 'Покрытие: ', 'Қамту: ') + text + '.';
    } else if (productId === 'casco' || productId === 'dms') {
      const values = packages(product.packages);
      const text = values.map(([name, value]) => {
        const content = productId === 'dms' ? value.covered : value;
        const rendered = textList(content);
        if (!rendered) return null;
        fact(['packages', name, ...(productId === 'dms' ? ['covered'] : [])], content);
        return packageName(name) + ': ' + rendered;
      });
      if (!text.length || text.some(x => !x)) return missing();
      answer = choose(language, 'Покрытие — ', 'Қамту — ') + text.join('; ') + '.';
    } else return missing();
  } else return missing();
  return { answer, facts: entries, sources: entries.map(entry => entry.path) };
}