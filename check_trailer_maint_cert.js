// 每月1號、15號執行：車輛與板架的驗車＋各項證件文件、保養（大/小保養）、板架出租合約、人員證照到期
const { todayISO, daysUntil, daysLabel, bucketByDate, supaFetch, supaFetchAll, sendEmail } = require('./notify_helpers');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL;

if (!SUPABASE_URL || !SUPABASE_KEY || !RESEND_API_KEY || !NOTIFY_EMAIL) {
  console.error('缺少必要環境變數，請檢查 GitHub Secrets 設定。');
  process.exit(1);
}

// 保養標準（對應原本儀表板內建的保養里程標準，車型名稱需與 vehicles.maintenance_model 完全一致）
const MAINTENANCE_STANDARDS = require('./maintenance_standards.json');

async function main() {
  console.log('開始檢查車輛／板架／保養／證照到期狀況...', todayISO());

  const [leases, vehicles, lessees, docs, schedules, mileageLogs, trainings, employees, trainingTypes, licences] = await Promise.all([
    supaFetch(SUPABASE_URL, SUPABASE_KEY, 'trailer_leases?status=eq.租賃中&select=*'),
    supaFetch(SUPABASE_URL, SUPABASE_KEY, 'vehicles?select=vehicle_id,plate_number,vehicle_category,vehicle_type,maintenance_model,current_mileage,status'),
    supaFetch(SUPABASE_URL, SUPABASE_KEY, 'lessees?select=lessee_id,lessee_name'),
    // 驗車和其他證件（行照／滅火器／濾毒罐／自主管理標章／行車記錄器）都在這張表，一次撈回來後再分開
    supaFetch(SUPABASE_URL, SUPABASE_KEY, 'vehicle_documents?select=*'),
    supaFetch(SUPABASE_URL, SUPABASE_KEY, 'maintenance_schedules?select=*'),
    supaFetchAll(SUPABASE_URL, SUPABASE_KEY, 'vehicle_mileage_logs?select=vehicle_id,mileage,log_date&order=log_date.desc'),
    supaFetch(SUPABASE_URL, SUPABASE_KEY, 'employee_trainings?no_expiry=eq.false&select=*'),
    supaFetch(SUPABASE_URL, SUPABASE_KEY, 'employees?select=employee_id,name,status,birth_date'),
    // 證照名稱存在 training_types 這張對照表，employee_trainings 只存 type_id，
    // 沒撈這張表的話信裡只會有證照號碼，看不出是危運、六小時還是堆高機
    supaFetch(SUPABASE_URL, SUPABASE_KEY, 'training_types?select=type_id,type_name'),
    // 駕照：審驗日（inspection_date）與到期日（expiry_date）分開存，兩種都提醒（SQL_169）
    supaFetch(SUPABASE_URL, SUPABASE_KEY, 'driver_licenses?select=*'),
  ]);

  // 報廢、繳銷的車不寄（跟儀表板 isRetiredVehicle 一樣）；「待賣出」「停用」照常寄
  const retired = new Set(vehicles.filter(v => v.status === '報廢' || v.status === '繳銷').map(v => v.vehicle_id));
  const vehicleById = Object.fromEntries(vehicles.map(v => [v.vehicle_id, v]));
  const lesseeById = Object.fromEntries(lessees.map(l => [l.lessee_id, l.lessee_name]));
  const employeeById = Object.fromEntries(employees.map(e => [e.employee_id, e.name]));
  const trainingTypeById = Object.fromEntries(trainingTypes.map(t => [t.type_id, t.type_name]));

  // 舊資料裡有「職業職業聯結車駕照」這種重複字的名稱，顯示前先修掉
  const cleanTypeName = n => String(n || '').replace(/^職業職業/, '職業').trim();

  // 判斷一台車是「車輛」還是「板架」：優先看 vehicles.vehicle_category，
  // 少數幾筆舊資料這欄是空的，就退而用車種名稱判斷（半拖車／貨櫃架／40' 都算板架）
  const isTrailer = (v) => {
    if (!v) return false;
    if (v.vehicle_category === '板架') return true;
    if (v.vehicle_category === '車輛') return false;
    return /半拖車|貨櫃架|^40/.test(String(v.vehicle_type || ''));
  };

  // 目前出租中的板架：整列上底色，管理人員一眼就知道這台在客戶手上，
  // 要約時間進場檢驗或換件得先跟承租廠商喬
  const leasedLesseeByVehicle = {};
  leases.forEach(l => {
    if (l.vehicle_id != null && !(l.vehicle_id in leasedLesseeByVehicle)) {
      leasedLesseeByVehicle[l.vehicle_id] = lesseeById[l.lessee_id] || '出租中';
    }
  });
  const LEASED_BG = 'style="background:#fff3cd;"';
  const rentTag = (id) => (id in leasedLesseeByVehicle)
    ? `🔶 出租中（${leasedLesseeByVehicle[id]}）`
    : '自用';
  const rowAttr = (id) => (id in leasedLesseeByVehicle) ? ` ${LEASED_BG}` : '';

  // ---------- 1. 板架出租合約到期 ----------
  const leaseItems = leases
    .filter(l => l.lease_end_date)
    .map(l => ({ ...l, plate: (vehicleById[l.vehicle_id] || {}).plate_number || '', lessee_name: lesseeById[l.lessee_id] || '' }));
  const leaseHtml = bucketByDate(leaseItems, 'lease_end_date', l => `<tr>
    <td>${l.plate}</td><td>${l.lessee_name}</td><td>${l.lease_end_date}</td><td>${daysLabel(l.lease_end_date)}</td>
  </tr>`, ['板架車號', '承租廠商', '合約到期日', '剩餘天數']);

  // ---------- 2. 驗車與其他證件到期（車輛與板架分開列，車輛在上、板架在下） ----------
  const allDocItems = docs
    .filter(d => d.expiry_date && !retired.has(d.vehicle_id))
    .map(d => {
      const v = vehicleById[d.vehicle_id] || {};
      return { ...d, plate: v.plate_number || '', vehicle_type: v.vehicle_type || '', is_trailer: isTrailer(v) };
    });
  const inspectionItems = allDocItems.filter(d => d.doc_type === '驗車');
  const otherDocItems = allDocItems.filter(d => d.doc_type !== '驗車');

  const vehicleInspectionHtml = bucketByDate(inspectionItems.filter(d => !d.is_trailer), 'expiry_date', d => `<tr>
    <td><b>${d.plate}</b></td><td>${d.vehicle_type}</td><td>${d.expiry_date}</td><td>${daysLabel(d.expiry_date)}</td>
  </tr>`, ['車號', '車種', '驗車到期日', '剩餘天數']);
  const trailerInspectionHtml = bucketByDate(inspectionItems.filter(d => d.is_trailer), 'expiry_date', d => `<tr${rowAttr(d.vehicle_id)}>
    <td><b>${d.plate}</b></td><td>${rentTag(d.vehicle_id)}</td><td>${d.expiry_date}</td><td>${daysLabel(d.expiry_date)}</td>
  </tr>`, ['板架車號', '出租狀態', '驗車到期日', '剩餘天數']);

  const vehicleDocHtml = bucketByDate(otherDocItems.filter(d => !d.is_trailer), 'expiry_date', d => `<tr>
    <td><b>${d.plate}</b></td><td>${d.doc_type}</td><td>${d.expiry_date}</td><td>${daysLabel(d.expiry_date)}</td>
  </tr>`, ['車號', '文件類型', '到期日', '剩餘天數']);
  const trailerDocHtml = bucketByDate(otherDocItems.filter(d => d.is_trailer), 'expiry_date', d => `<tr${rowAttr(d.vehicle_id)}>
    <td><b>${d.plate}</b></td><td>${rentTag(d.vehicle_id)}</td><td>${d.doc_type}</td><td>${d.expiry_date}</td><td>${daysLabel(d.expiry_date)}</td>
  </tr>`, ['板架車號', '出租狀態', '文件類型', '到期日', '剩餘天數']);

  // ---------- 3. 人員證照到期 ----------
  // 駕照改由下面「駕照審驗／換照」那兩段提醒（看駕照資料），外訓表的駕照列就不重複列
  const normLic = n => String(n || '').trim().replace(/駕照$/, '').replace(/^(職業)+/, '職業').trim();
  const hasLicence = new Set(licences.map(d => d.employee_id + '|' + normLic(d.license_type)));
  // 只寄在職人員的：離職的人證照紀錄會留著查沿革，但不該再催（名字也會是空白）
  const activeEmp = new Set(employees.filter(e => e.status === '在職').map(e => e.employee_id));
  const certItems = trainings
    .filter(t => t.expiry_date && activeEmp.has(t.employee_id))
    .filter(t => {
      const n = String(trainingTypeById[t.type_id] || '').trim();
      return !(/駕照$/.test(n) && hasLicence.has(t.employee_id + '|' + normLic(n)));
    })
    .map(t => ({
      ...t,
      employee_name: employeeById[t.employee_id] || '',
      type_name: cleanTypeName(trainingTypeById[t.type_id]) || '（未分類）',
    }));
  // 證照號碼不列出來：換地方報名就會拿到不同號碼，列了反而誤導，看名稱和到期日就夠
  const certHtml = bucketByDate(certItems, 'expiry_date', t => `<tr>
    <td>${t.employee_name}</td><td><b>${t.type_name}</b></td><td>${t.expiry_date}</td><td>${daysLabel(t.expiry_date)}</td>
  </tr>`, ['姓名', '證照／訓練名稱', '到期日', '剩餘天數']);

  // ---------- 3b. 駕照審驗／換照（只看在職） ----------
  // 職業駕照有效期 6 年，第 3 年要審驗；年滿 60 歲每年審驗（附體檢）。
  // inspected_on（審驗完成日）有填、而且不早於審驗日前 60 天，就算辦完了，不再提醒。
  const d10 = v => { const s = String(v || '').slice(0, 10); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : ''; };
  const empById = Object.fromEntries(employees.map(e => [e.employee_id, e]));
  const ageOf = (e) => {
    const b = d10(e && e.birth_date); if (!b) return null;
    const t = todayISO();
    return Number(t.slice(0, 4)) - Number(b.slice(0, 4)) - (t.slice(5) < b.slice(5) ? 1 : 0);
  };
  const activeLic = licences
    .filter(d => (empById[d.employee_id] || {}).status === '在職')
    .map(d => {
      const e = empById[d.employee_id] || {};
      const age = ageOf(e);
      const insp = d10(d.inspection_date), exp = d10(d.expiry_date), on = d10(d.inspected_on);
      const done = !!(insp && on && daysUntil(on) - daysUntil(insp) >= -60);
      return { name: e.name || '', kind: normLic(d.license_type), age, insp, exp, done,
               old60: age != null && age >= 60 };
    });
  const licInspItems = activeLic.filter(x => x.insp && x.exp && x.insp < x.exp && !x.done);
  const licExpItems = activeLic.filter(x => x.exp);
  const ageTag = x => x.old60 ? `<br><span style="color:#888;">${x.age} 歲：每年審驗＋體檢</span>` : '';
  const licInspHtml = bucketByDate(licInspItems, 'insp', x => `<tr>
    <td>${x.name}</td><td><b>${x.kind}</b></td><td>${x.insp}</td><td>${daysLabel(x.insp).replace('到期', '')}</td><td>${x.exp}</td>
  </tr>`, ['姓名', '駕照類別', '審驗日', '剩餘天數', '有效期（到期日）'], '要審驗');
  const licExpHtml = bucketByDate(licExpItems, 'exp', x => `<tr>
    <td>${x.name}</td><td><b>${x.kind}</b></td><td>${x.exp}</td><td>${daysLabel(x.exp)}</td><td>${x.old60 && x.insp === x.exp && !x.done ? '審驗（每年）' : '換照'}${ageTag(x)}</td>
  </tr>`, ['姓名', '駕照類別', '到期日', '剩餘天數', '要辦']);

  // ---------- 4. 車輛保養（里程制，不適用90/60/30天分段，改用剩餘里程判斷） ----------
  const latestMileage = {};
  mileageLogs.forEach(m => {
    if (!(m.vehicle_id in latestMileage)) latestMileage[m.vehicle_id] = m.mileage;
  });
  const vehicleMaintRows = [];
  const trailerMaintRows = [];
  vehicles.forEach(v => {
    if (retired.has(v.vehicle_id)) return;
    const std = MAINTENANCE_STANDARDS.find(s => s.model_name === v.maintenance_model);
    if (!std) return;
    const currentMileage = latestMileage[v.vehicle_id] ?? v.current_mileage;
    if (currentMileage == null) return;
    [['小保養', std.small_service_km], ['大保養', std.large_service_km]].forEach(([label, km]) => {
      if (!km) return;
      const sched = schedules.find(s => s.vehicle_id === v.vehicle_id && s.maintenance_type === label);
      if (!sched || sched.last_service_mileage == null) return;
      const nextDue = sched.last_service_mileage + km;
      const remaining = nextDue - currentMileage;
      const buffer = Math.max(1000, km * 0.05);
      if (remaining > buffer) return; // 還很遠，不列入通知
      const status = remaining <= 0 ? '🔴 已逾期' : '🟠 即將到期';
      const trailer = isTrailer(v);
      const rentCell = trailer ? `<td>${rentTag(v.vehicle_id)}</td>` : '';
      const row = `<tr${trailer ? rowAttr(v.vehicle_id) : ''}><td><b>${v.plate_number}</b></td>${rentCell}<td>${label}</td><td>${status}</td><td>剩餘約 ${remaining} km（下次保養里程 ${nextDue} km）</td></tr>`;
      (trailer ? trailerMaintRows : vehicleMaintRows).push(row);
    });
  });
  const maintTable = (rows, title, cols, note = '依剩餘里程判斷') => rows.length
    ? `<h4 style="font-family:sans-serif;margin:14px 0 6px;">🔧 ${title}（共${rows.length}筆，${note}）</h4>
       <table style="border-collapse:collapse;font-family:sans-serif;font-size:13px;width:100%;" border="1" cellpadding="6">
         <tr style="background:#f2ece5;">${cols.map(c => `<th style="text-align:left;white-space:nowrap;">${c}</th>`).join('')}</tr>
         ${rows.join('')}
       </table>`
    : '';
  const vehicleMaintHtml = maintTable(vehicleMaintRows, '車輛保養提醒', ['車號', '保養類型', '狀態', '說明']);
  const trailerMaintHtml = maintTable(trailerMaintRows, '板架保養提醒', ['板架車號', '出租狀態', '保養類型', '狀態', '說明']);

  // ---------- 5. 打油、輪軸保養（判斷方式和儀表板完全一致） ----------
  // 板架是「時間型」：上次保養日期 + 頻率月數；曳引車輪軸是「里程型」：上次里程 + 頻率公里。
  // 用有沒有 frequency_km 來區分，不是看類型名稱。
  const addMonths = (dateStr, n) => {
    const d = new Date(dateStr.slice(0, 10) + 'T00:00:00');
    const day = d.getDate();
    d.setMonth(d.getMonth() + n);
    if (d.getDate() !== day) d.setDate(0); // 例如 1/31 加一個月要落在 2月底
    return d.toISOString().slice(0, 10);
  };
  const scheduleDue = (s, v) => {
    if (s.frequency_km) {
      const cur = latestMileage[s.vehicle_id] ?? v.current_mileage;
      if (cur == null || s.last_service_mileage == null) return null; // 沒里程資料就沒辦法判斷
      const next = s.last_service_mileage + s.frequency_km;
      const rem = next - cur;
      const buf = Math.max(1000, s.frequency_km * 0.05);
      if (rem > buf) return null; // 還很遠
      return {
        basis: 'km',
        overdue: rem <= 0,
        last: s.last_service_mileage + ' km',
        next: next + ' km',
        remain: rem <= 0 ? `超出 ${-rem} km` : `剩 ${rem} km`,
        sortKey: rem,
      };
    }
    if (s.frequency_months && s.last_service_date) {
      const next = addMonths(s.last_service_date, s.frequency_months);
      const dd = daysUntil(next);
      if (dd > 30) return null; // 逾期或30天內才提醒，和儀表板的紅／橘燈一致
      return {
        basis: 'time',
        overdue: dd < 0,
        last: s.last_service_date.slice(0, 10),
        next,
        remain: dd < 0 ? `逾期 ${-dd} 天` : `剩 ${dd} 天`,
        sortKey: dd,
      };
    }
    return null; // 資料不足
  };
  const buildDueRows = (type) => {
    const out = { vehicle: [], trailer: [] };
    schedules.filter(s => s.maintenance_type === type).forEach(s => {
      const v = vehicleById[s.vehicle_id];
      if (!v || retired.has(s.vehicle_id)) return;
      const d = scheduleDue(s, v);
      if (!d) return;
      out[isTrailer(v) ? 'trailer' : 'vehicle'].push({ plate: v.plate_number, vehicle_id: s.vehicle_id, trailer: isTrailer(v), ...d });
    });
    // 同一張表可能同時有里程型和時間型，先照類型分群，各自再依剩餘量由少到多排
    Object.values(out).forEach(arr => arr.sort((a, b) =>
      a.basis === b.basis ? a.sortKey - b.sortKey : (a.basis === 'time' ? -1 : 1)));
    return out;
  };
  const dueRowHtml = (d) => `<tr${d.trailer ? rowAttr(d.vehicle_id) : ''}>
      <td><b>${d.plate}</b></td>${d.trailer ? `<td>${rentTag(d.vehicle_id)}</td>` : ''}
      <td>${d.overdue ? '🔴 已逾期' : '🟠 即將到期'}</td><td>${d.last}</td><td>${d.next}</td><td>${d.remain}</td>
    </tr>`;
  const dueTable = (rows, title) => {
    if (!rows.length) return '';
    // 標題要說清楚是照里程還是照時間算的，兩種都有就寫兩種
    const hasKm = rows.some(r => r.basis === 'km');
    const hasTime = rows.some(r => r.basis === 'time');
    const note = hasKm && hasTime ? '里程型與時間型都有' : hasKm ? '依剩餘里程判斷' : '依上次保養日期＋週期月數判斷';
    return maintTable(rows.map(dueRowHtml), title,
      rows[0].trailer
        ? ['板架車號', '出租狀態', '狀態', '上次保養', '預估下次', '剩餘']
        : ['車號', '狀態', '上次保養', '預估下次', '剩餘'],
      note);
  };
  const grease = buildDueRows('打油');
  const axle = buildDueRows('輪軸保養');
  const vehicleGreaseHtml = dueTable(grease.vehicle, '車輛打油提醒');
  const trailerGreaseHtml = dueTable(grease.trailer, '板架打油提醒');
  const vehicleAxleHtml = dueTable(axle.vehicle, '車輛輪軸保養提醒');
  const trailerAxleHtml = dueTable(axle.trailer, '板架輪軸保養提醒');

  const totalCount = leaseItems.filter(l => daysUntil(l.lease_end_date) <= 90).length
    + allDocItems.filter(d => daysUntil(d.expiry_date) <= 90).length
    + certItems.filter(t => daysUntil(t.expiry_date) <= 90).length
    + licInspItems.filter(x => daysUntil(x.insp) <= 90).length
    + licExpItems.filter(x => daysUntil(x.exp) <= 90).length
    + vehicleMaintRows.length + trailerMaintRows.length
    + grease.vehicle.length + grease.trailer.length
    + axle.vehicle.length + axle.trailer.length;

  if (totalCount === 0) {
    console.log('目前沒有需要通知的車輛／板架／保養／證照項目，不寄信。');
    return;
  }

  // 版面順序：先車輛（驗車、保養），再板架（驗車、保養、出租合約），最後人員證照
  const bar = 'style="font-family:sans-serif;border-bottom:2px solid #9d6d2f;"';
  const groupBar = 'style="font-family:sans-serif;background:#5a4632;color:#fff;padding:8px 12px;margin:26px 0 4px;border-radius:4px;"';

  let html = `<h2 style="font-family:sans-serif;">車輛／板架／人員證照到期通知（${todayISO()}）</h2>`;

  if (vehicleInspectionHtml || vehicleDocHtml || vehicleMaintHtml || vehicleGreaseHtml || vehicleAxleHtml) {
    html += `<h2 ${groupBar}>🚛 車輛</h2>`;
    if (vehicleInspectionHtml) html += `<h3 ${bar}>🚛 車輛驗車到期</h3>${vehicleInspectionHtml}`;
    if (vehicleDocHtml) html += `<h3 ${bar}>📄 車輛文件到期（行照／滅火器／濾毒罐／自主管理標章／行車記錄器）</h3>${vehicleDocHtml}`;
    if (vehicleMaintHtml) html += `<h3 ${bar}>🔧 車輛保養</h3>${vehicleMaintHtml}`;
    if (vehicleGreaseHtml) html += `<h3 ${bar}>🛢 車輛打油</h3>${vehicleGreaseHtml}`;
    if (vehicleAxleHtml) html += `<h3 ${bar}>⚙️ 車輛輪軸保養</h3>${vehicleAxleHtml}`;
  }

  if (trailerInspectionHtml || trailerDocHtml || trailerMaintHtml || trailerGreaseHtml || trailerAxleHtml || leaseHtml) {
    html += `<h2 ${groupBar}>🚚 板架</h2>
      <p style="font-family:sans-serif;font-size:13px;margin:6px 0 0;">
        <span style="background:#fff3cd;border:1px solid #d8bf6a;padding:0 14px;">&nbsp;</span>
        　黃底的列＝這台板架目前<b>出租中</b>，要安排進場檢驗或維修前，請先跟承租廠商聯絡。
      </p>`;
    if (trailerInspectionHtml) html += `<h3 ${bar}>🚚 板架驗車到期</h3>${trailerInspectionHtml}`;
    if (trailerDocHtml) html += `<h3 ${bar}>📄 板架文件到期（行照等）</h3>${trailerDocHtml}`;
    if (trailerMaintHtml) html += `<h3 ${bar}>🔧 板架保養</h3>${trailerMaintHtml}`;
    if (trailerGreaseHtml) html += `<h3 ${bar}>🛢 板架打油</h3>${trailerGreaseHtml}`;
    if (trailerAxleHtml) html += `<h3 ${bar}>⚙️ 板架輪軸保養</h3>${trailerAxleHtml}`;
    if (leaseHtml) html += `<h3 ${bar}>📋 板架出租合約到期</h3>${leaseHtml}`;
  }

  if (certHtml || licInspHtml || licExpHtml) html += `<h2 ${groupBar}>🎓 人員</h2>`;
  if (licExpHtml) html += `<h3 ${bar}>🪪 駕照到期（要換照）</h3>${licExpHtml}`;
  if (licInspHtml) html += `<h3 ${bar}>🪪 駕照審驗</h3>
    <p style="font-family:sans-serif;font-size:13px;margin:6px 0;color:#555;">審驗日前後一個月內要去監理站辦，逾期一年以上駕照會被註銷。辦完請到儀表板總覽的「駕照審驗／到期提醒」按「已審驗」，下次就不會再寄。</p>${licInspHtml}`;
  if (certHtml) html += `<h3 ${bar}>🎓 人員證照到期</h3>${certHtml}`;
  html += `<p style="font-family:sans-serif;color:#888;font-size:12px;">此信由系統自動於每月1號、15號寄送，資料來源：順亞運通車隊儀表板。人員體檢、儀器校正與車輛保險在另一份「其餘物品」通知信裡。</p>`;

  const recipients = NOTIFY_EMAIL.split(',').map(s => s.trim()).filter(Boolean);
  await sendEmail(RESEND_API_KEY, recipients, `【到期通知】車輛／板架／證照 共 ${totalCount} 筆項目`, html);
  console.log(`寄信成功，共 ${totalCount} 筆。`);
}

main().catch(err => {
  console.error('執行失敗:', err);
  process.exit(1);
});
