// 每月1號、15號執行：板架到期（合約+驗車）、車輛保養（大/小保養）、人員證照到期
const { todayISO, daysUntil, bucketByDate, supaFetch, sendEmail } = require('./notify_helpers');

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
  console.log('開始檢查板架／保養／證照到期狀況...', todayISO());

  const [leases, vehicles, lessees, docs, schedules, mileageLogs, trainings, employees] = await Promise.all([
    supaFetch(SUPABASE_URL, SUPABASE_KEY, 'trailer_leases?status=eq.租賃中&select=*'),
    supaFetch(SUPABASE_URL, SUPABASE_KEY, 'vehicles?select=vehicle_id,plate_number,maintenance_model,current_mileage'),
    supaFetch(SUPABASE_URL, SUPABASE_KEY, 'lessees?select=lessee_id,lessee_name'),
    supaFetch(SUPABASE_URL, SUPABASE_KEY, 'vehicle_documents?doc_type=eq.驗車&select=*'),
    supaFetch(SUPABASE_URL, SUPABASE_KEY, 'maintenance_schedules?select=*'),
    supaFetch(SUPABASE_URL, SUPABASE_KEY, 'vehicle_mileage_logs?select=vehicle_id,mileage,log_date&order=log_date.desc'),
    supaFetch(SUPABASE_URL, SUPABASE_KEY, 'employee_trainings?no_expiry=eq.false&select=*'),
    supaFetch(SUPABASE_URL, SUPABASE_KEY, 'employees?select=employee_id,name'),
  ]);

  const vehicleById = Object.fromEntries(vehicles.map(v => [v.vehicle_id, v]));
  const lesseeById = Object.fromEntries(lessees.map(l => [l.lessee_id, l.lessee_name]));
  const employeeById = Object.fromEntries(employees.map(e => [e.employee_id, e.name]));

  // ---------- 1. 板架出租合約到期 ----------
  const leaseItems = leases
    .filter(l => l.lease_end_date)
    .map(l => ({ ...l, plate: (vehicleById[l.vehicle_id] || {}).plate_number || '', lessee_name: lesseeById[l.lessee_id] || '' }));
  const leaseHtml = bucketByDate(leaseItems, 'lease_end_date', l => `<tr>
    <td>${l.plate}</td><td>${l.lessee_name}</td><td>${l.lease_end_date}</td>
  </tr>`);

  // ---------- 2. 板架驗車到期 ----------
  const inspectionItems = docs
    .filter(d => d.expiry_date)
    .map(d => ({ ...d, plate: (vehicleById[d.vehicle_id] || {}).plate_number || '' }));
  const inspectionHtml = bucketByDate(inspectionItems, 'expiry_date', d => `<tr>
    <td>${d.plate}</td><td>${d.expiry_date}</td>
  </tr>`);

  // ---------- 3. 人員證照到期 ----------
  const certItems = trainings
    .filter(t => t.expiry_date)
    .map(t => ({ ...t, employee_name: employeeById[t.employee_id] || '' }));
  const certHtml = bucketByDate(certItems, 'expiry_date', t => `<tr>
    <td>${t.employee_name}</td><td>${t.certificate_no || ''}</td><td>${t.expiry_date}</td>
  </tr>`);

  // ---------- 4. 車輛保養（里程制，不適用90/60/30天分段，改用剩餘里程判斷） ----------
  const latestMileage = {};
  mileageLogs.forEach(m => {
    if (!(m.vehicle_id in latestMileage)) latestMileage[m.vehicle_id] = m.mileage;
  });
  const maintRows = [];
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
      maintRows.push(`<tr><td>${v.plate_number}</td><td>${label}</td><td>${status}</td><td>剩餘約 ${remaining} km（下次保養里程 ${nextDue} km）</td></tr>`);
    });
  });
  const maintHtml = maintRows.length
    ? `<h4 style="font-family:sans-serif;margin:14px 0 6px;">🔧 車輛保養提醒（共${maintRows.length}筆，依剩餘里程判斷）</h4>
       <table style="border-collapse:collapse;font-family:sans-serif;font-size:13px;width:100%;" border="1" cellpadding="6">
         <tr style="background:#f2ece5;"><th>車號</th><th>保養類型</th><th>狀態</th><th>說明</th></tr>
         ${maintRows.join('')}
       </table>`
    : '';

  const totalCount = leaseItems.filter(l => daysUntil(l.lease_end_date) <= 90).length
    + inspectionItems.filter(d => daysUntil(d.expiry_date) <= 90).length
    + certItems.filter(t => daysUntil(t.expiry_date) <= 90).length
    + maintRows.length;

  if (totalCount === 0) {
    console.log('目前沒有需要通知的板架／保養／證照項目，不寄信。');
    return;
  }

  let html = `<h2 style="font-family:sans-serif;">板架／車輛保養／人員證照到期通知（${todayISO()}）</h2>`;
  if (leaseHtml) html += `<h3 style="font-family:sans-serif;border-bottom:2px solid #9d6d2f;">📋 板架出租合約到期</h3>${leaseHtml}`;
  if (inspectionHtml) html += `<h3 style="font-family:sans-serif;border-bottom:2px solid #9d6d2f;">🚚 板架驗車到期</h3>${inspectionHtml}`;
  if (maintHtml) html += `<h3 style="font-family:sans-serif;border-bottom:2px solid #9d6d2f;">🔧 車輛保養</h3>${maintHtml}`;
  if (certHtml) html += `<h3 style="font-family:sans-serif;border-bottom:2px solid #9d6d2f;">🎓 人員證照到期</h3>${certHtml}`;
  html += `<p style="font-family:sans-serif;color:#888;font-size:12px;">此信由系統自動於每月1號、15號寄送，資料來源：順亞運通車隊儀表板。</p>`;

  const recipients = NOTIFY_EMAIL.split(',').map(s => s.trim()).filter(Boolean);
  await sendEmail(RESEND_API_KEY, recipients, `【到期通知】板架／保養／證照 共 ${totalCount} 筆項目`, html);
  console.log(`寄信成功，共 ${totalCount} 筆。`);
}

main().catch(err => {
  console.error('執行失敗:', err);
  process.exit(1);
});
