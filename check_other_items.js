// 每月1號執行：其餘物品到期（車輛保險、車輛文件、體檢、儀器校正）
const { todayISO, daysUntil, bucketByDate, supaFetch, sendEmail } = require('./notify_helpers');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL;

if (!SUPABASE_URL || !SUPABASE_KEY || !RESEND_API_KEY || !NOTIFY_EMAIL) {
  console.error('缺少必要環境變數，請檢查 GitHub Secrets 設定。');
  process.exit(1);
}

async function main() {
  console.log('開始檢查其餘物品到期狀況...', todayISO());

  const [insurance, docs, vehicles, medExams, employees, instruments] = await Promise.all([
    supaFetch(SUPABASE_URL, SUPABASE_KEY, 'vehicle_insurance?select=*'),
    supaFetch(SUPABASE_URL, SUPABASE_KEY, 'vehicle_documents?doc_type=neq.驗車&select=*'), // 驗車已在另一份板架通知涵蓋，這裡排除避免重複
    supaFetch(SUPABASE_URL, SUPABASE_KEY, 'vehicles?select=vehicle_id,plate_number'),
    supaFetch(SUPABASE_URL, SUPABASE_KEY, 'medical_exam_records?select=*'),
    supaFetch(SUPABASE_URL, SUPABASE_KEY, 'employees?select=employee_id,name'),
    supaFetch(SUPABASE_URL, SUPABASE_KEY, 'instruments?select=*'),
  ]);

  const vehicleById = Object.fromEntries(vehicles.map(v => [v.vehicle_id, v.plate_number]));
  const employeeById = Object.fromEntries(employees.map(e => [e.employee_id, e.name]));

  // ---------- 1. 車輛保險到期 ----------
  const insItems = insurance
    .filter(i => i.expiry_date)
    .map(i => ({ ...i, plate: vehicleById[i.vehicle_id] || '' }));
  const insHtml = bucketByDate(insItems, 'expiry_date', i => `<tr>
    <td>${i.plate}</td><td>${i.insurance_type || ''}</td><td>${i.insurance_company || ''}</td><td>${i.expiry_date}</td>
  </tr>`);

  // ---------- 2. 其他車輛文件到期（行照/滅火器/濾毒罐/自主管理標章/行車記錄器，驗車已排除） ----------
  const docItems = docs
    .filter(d => d.expiry_date)
    .map(d => ({ ...d, plate: vehicleById[d.vehicle_id] || '' }));
  const docHtml = bucketByDate(docItems, 'expiry_date', d => `<tr>
    <td>${d.plate}</td><td>${d.doc_type}</td><td>${d.expiry_date}</td>
  </tr>`);

  // ---------- 3. 人員體檢到期 ----------
  const medItems = medExams
    .filter(m => m.next_due_date)
    .map(m => ({ ...m, employee_name: employeeById[m.employee_id] || '' }));
  const medHtml = bucketByDate(medItems, 'next_due_date', m => `<tr>
    <td>${m.employee_name}</td><td>${m.next_due_date}</td>
  </tr>`);

  // ---------- 4. 儀器校正到期（直接用 instruments 表上的下次校正日期欄位） ----------
  const calItems = instruments.filter(i => i.next_calibration_due);
  const calHtml = bucketByDate(calItems, 'next_calibration_due', i => `<tr>
    <td>${i.brand_model || ''}</td><td>${i.asset_no || ''}</td><td>${i.storage_area || ''}</td><td>${i.next_calibration_due}</td>
  </tr>`);

  const totalCount = insItems.filter(i => daysUntil(i.expiry_date) <= 90).length
    + docItems.filter(d => daysUntil(d.expiry_date) <= 90).length
    + medItems.filter(m => daysUntil(m.next_due_date) <= 90).length
    + calItems.filter(c => daysUntil(c.next_calibration_due) <= 90).length;

  if (totalCount === 0) {
    console.log('目前沒有需要通知的其餘物品到期項目，不寄信。');
    return;
  }

  let html = `<h2 style="font-family:sans-serif;">其餘物品到期通知（${todayISO()}）</h2>`;
  if (insHtml) html += `<h3 style="font-family:sans-serif;border-bottom:2px solid #9d6d2f;">🚗 車輛保險到期</h3>${insHtml}`;
  if (docHtml) html += `<h3 style="font-family:sans-serif;border-bottom:2px solid #9d6d2f;">📄 車輛文件到期（行照／滅火器／濾毒罐／自主管理標章／行車記錄器）</h3>${docHtml}`;
  if (medHtml) html += `<h3 style="font-family:sans-serif;border-bottom:2px solid #9d6d2f;">🏥 人員體檢到期</h3>${medHtml}`;
  if (calHtml) html += `<h3 style="font-family:sans-serif;border-bottom:2px solid #9d6d2f;">🔬 儀器校正到期</h3>${calHtml}`;
  html += `<p style="font-family:sans-serif;color:#888;font-size:12px;">此信由系統自動於每月1號寄送，資料來源：順亞運通車隊儀表板。板架驗車已在另一份「板架/保養/證照」通知信裡，這裡不重複列出。</p>`;

  const recipients = NOTIFY_EMAIL.split(',').map(s => s.trim()).filter(Boolean);
  await sendEmail(RESEND_API_KEY, recipients, `【到期通知】其餘物品 共 ${totalCount} 筆項目`, html);
  console.log(`寄信成功，共 ${totalCount} 筆。`);
}

main().catch(err => {
  console.error('執行失敗:', err);
  process.exit(1);
});
