// 每月1號、15號執行：車輛與板架的驗車＋各項證件文件、保養（大/小保養）、板架出租合約、人員證照到期
const { todayISO, daysUntil, daysLabel, bucketByDate, supaFetch, sendEmail } = require('./notify_helpers');

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

  const [leases, vehicles, lessees, docs, schedules, mileageLogs, trainings, employees, trainingTypes] = await Promise.all([
    supaFetch(SUPABASE_URL, SUPABASE_KEY, 'trailer_leases?status=eq.租賃中&select=*'),
    supaFetch(SUPABASE_URL, SUPABASE_KEY, 'vehicles?select=vehicle_id,plate_number,vehicle_category,vehicle_type,maintenance_model,current_mileage'),
    supaFetch(SUPABASE_URL, SUPABASE_KEY, 'lessees?select=lessee_id,lessee_name'),
    // 驗車和其他證件（行照／滅火器／濾毒罐／自主管理標章／行車記錄器）都在這張表，一次撈回來後再分開
    supaFetch(SUPABASE_URL, SUPABASE_KEY, 'vehicle_documents?select=*'),
    supaFetch(SUPABASE_URL, SUPABASE_KEY, 'maintenance_schedules?select=*'),
    supaFetch(SUPABASE_URL, SUPABASE_KEY, 'vehicle_mileage_logs?select=vehicle_id,mileage,log_date&order=log_date.desc'),
    supaFetch(SUPABASE_URL, SUPABASE_KEY, 'employee_trainings?no_expiry=eq.false&select=*'),
    supaFetch(SUPABASE_URL, SUPABASE_KEY, 'employees?select=employee_id,name'),
    // 證照名稱存在 training_types 這張對照表，employee_trainings 只存 type_id，
    // 沒撈這張表的話信裡只會有證照號碼，看不出是危運、六小時還是堆高機
    supaFetch(SUPABASE_URL, SUPABASE_KEY, 'training_types?select=type_id,type_name'),
  ]);

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
    .filter(d => d.expiry_date)
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
  const certItems = trainings
    .filter(t => t.expiry_date)
    .map(t => ({
      ...t,
      employee_name: employeeById[t.employee_id] || '',
      type_name: cleanTypeName(trainingTypeById[t.type_id]) || '（未分類）',
    }));
  // 證照號碼不列出來：換地方報名就會拿到不同號碼，列了反而誤導，看名稱和到期日就夠
  const certHtml = bucketByDate(certItems, 'expiry_date', t => `<tr>
    <td>${t.employee_name}</td><td><b>${t.type_name}</b></td><td>${t.expiry_date}</td><td>${daysLabel(t.expiry_date)}</td>
  </tr>`, ['姓名', '證照／訓練名稱', '到期日', '剩餘天數']);

  // ---------- 4. 車輛保養（里程制，不適用90/60/30天分段，改用剩餘里程判斷） ----------
  const latestMileage = {};
  mileageLogs.forEach(m => {
    if (!(m.vehicle_id in latestMileage)) latestMileage[m.vehicle_id] = m.mileage;
  });
  const vehicleMaintRows = [];
  const trailerMaintRows = [];
  vehicles.forEach(v => {
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
  const maintTable = (rows, title, cols) => rows.length
    ? `<h4 style="font-family:sans-serif;margin:14px 0 6px;">🔧 ${title}（共${rows.length}筆，依剩餘里程判斷）</h4>
       <table style="border-collapse:collapse;font-family:sans-serif;font-size:13px;width:100%;" border="1" cellpadding="6">
         <tr style="background:#f2ece5;">${cols.map(c => `<th style="text-align:left;white-space:nowrap;">${c}</th>`).join('')}</tr>
         ${rows.join('')}
       </table>`
    : '';
  const vehicleMaintHtml = maintTable(vehicleMaintRows, '車輛保養提醒', ['車號', '保養類型', '狀態', '說明']);
  const trailerMaintHtml = maintTable(trailerMaintRows, '板架保養提醒', ['板架車號', '出租狀態', '保養類型', '狀態', '說明']);

  const totalCount = leaseItems.filter(l => daysUntil(l.lease_end_date) <= 90).length
    + allDocItems.filter(d => daysUntil(d.expiry_date) <= 90).length
    + certItems.filter(t => daysUntil(t.expiry_date) <= 90).length
    + vehicleMaintRows.length + trailerMaintRows.length;

  if (totalCount === 0) {
    console.log('目前沒有需要通知的車輛／板架／保養／證照項目，不寄信。');
    return;
  }

  // 版面順序：先車輛（驗車、保養），再板架（驗車、保養、出租合約），最後人員證照
  const bar = 'style="font-family:sans-serif;border-bottom:2px solid #9d6d2f;"';
  const groupBar = 'style="font-family:sans-serif;background:#5a4632;color:#fff;padding:8px 12px;margin:26px 0 4px;border-radius:4px;"';

  let html = `<h2 style="font-family:sans-serif;">車輛／板架／人員證照到期通知（${todayISO()}）</h2>`;

  if (vehicleInspectionHtml || vehicleDocHtml || vehicleMaintHtml) {
    html += `<h2 ${groupBar}>🚛 車輛</h2>`;
    if (vehicleInspectionHtml) html += `<h3 ${bar}>🚛 車輛驗車到期</h3>${vehicleInspectionHtml}`;
    if (vehicleDocHtml) html += `<h3 ${bar}>📄 車輛文件到期（行照／滅火器／濾毒罐／自主管理標章／行車記錄器）</h3>${vehicleDocHtml}`;
    if (vehicleMaintHtml) html += `<h3 ${bar}>🔧 車輛保養</h3>${vehicleMaintHtml}`;
  }

  if (trailerInspectionHtml || trailerDocHtml || trailerMaintHtml || leaseHtml) {
    html += `<h2 ${groupBar}>🚚 板架</h2>
      <p style="font-family:sans-serif;font-size:13px;margin:6px 0 0;">
        <span style="background:#fff3cd;border:1px solid #d8bf6a;padding:0 14px;">&nbsp;</span>
        　黃底的列＝這台板架目前<b>出租中</b>，要安排進場檢驗或維修前，請先跟承租廠商聯絡。
      </p>`;
    if (trailerInspectionHtml) html += `<h3 ${bar}>🚚 板架驗車到期</h3>${trailerInspectionHtml}`;
    if (trailerDocHtml) html += `<h3 ${bar}>📄 板架文件到期（行照等）</h3>${trailerDocHtml}`;
    if (trailerMaintHtml) html += `<h3 ${bar}>🔧 板架保養</h3>${trailerMaintHtml}`;
    if (leaseHtml) html += `<h3 ${bar}>📋 板架出租合約到期</h3>${leaseHtml}`;
  }

  if (certHtml) html += `<h2 ${groupBar}>🎓 人員</h2><h3 ${bar}>🎓 人員證照到期</h3>${certHtml}`;
  html += `<p style="font-family:sans-serif;color:#888;font-size:12px;">此信由系統自動於每月1號、15號寄送，資料來源：順亞運通車隊儀表板。人員體檢、儀器校正與車輛保險在另一份「其餘物品」通知信裡。</p>`;

  const recipients = NOTIFY_EMAIL.split(',').map(s => s.trim()).filter(Boolean);
  await sendEmail(RESEND_API_KEY, recipients, `【到期通知】車輛／板架／證照 共 ${totalCount} 筆項目`, html);
  console.log(`寄信成功，共 ${totalCount} 筆。`);
}

main().catch(err => {
  console.error('執行失敗:', err);
  process.exit(1);
});
