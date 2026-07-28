// 每月1號執行：其餘物品到期（車輛／板架保險、人員體檢、儀器校正）
// 註：驗車與行照等各項證件文件已移到「車輛／板架／證照」那封信（每月1號、15號），這裡不重複列出。
const { todayISO, daysUntil, daysLabel, bucketByDate, supaFetch, sendEmail } = require('./notify_helpers');

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

  const [insurance, vehicles, medExams, employees, instruments, leases, lessees] = await Promise.all([
    supaFetch(SUPABASE_URL, SUPABASE_KEY, 'vehicle_insurance?select=*'),
    supaFetch(SUPABASE_URL, SUPABASE_KEY, 'vehicles?select=vehicle_id,plate_number,vehicle_category,vehicle_type'),
    supaFetch(SUPABASE_URL, SUPABASE_KEY, 'medical_exam_records?select=*'),
    supaFetch(SUPABASE_URL, SUPABASE_KEY, 'employees?select=employee_id,name'),
    supaFetch(SUPABASE_URL, SUPABASE_KEY, 'instruments?select=*'),
    // 出租中的板架要在表格裡上底色，所以這裡也要知道哪幾台在客戶那邊
    supaFetch(SUPABASE_URL, SUPABASE_KEY, 'trailer_leases?status=eq.租賃中&select=vehicle_id,lessee_id'),
    supaFetch(SUPABASE_URL, SUPABASE_KEY, 'lessees?select=lessee_id,lessee_name'),
  ]);

  const vehicleById = Object.fromEntries(vehicles.map(v => [v.vehicle_id, v]));
  const employeeById = Object.fromEntries(employees.map(e => [e.employee_id, e.name]));

  // 判斷一台車是「車輛」還是「板架」：優先看 vehicles.vehicle_category，
  // 少數幾筆舊資料這欄是空的，就退而用車種名稱判斷（半拖車／貨櫃架／40' 都算板架）
  const isTrailer = (v) => {
    if (!v) return false;
    if (v.vehicle_category === '板架') return true;
    if (v.vehicle_category === '車輛') return false;
    return /半拖車|貨櫃架|^40/.test(String(v.vehicle_type || ''));
  };
  const attachVehicle = (row) => {
    const v = vehicleById[row.vehicle_id] || {};
    return { ...row, plate: v.plate_number || '', vehicle_type: v.vehicle_type || '', is_trailer: isTrailer(v) };
  };

  // 目前出租中的板架：整列上底色，管理人員一眼就知道這台在客戶手上
  const lesseeById = Object.fromEntries(lessees.map(l => [l.lessee_id, l.lessee_name]));
  const leasedLesseeByVehicle = {};
  leases.forEach(l => {
    if (l.vehicle_id != null && !(l.vehicle_id in leasedLesseeByVehicle)) {
      leasedLesseeByVehicle[l.vehicle_id] = lesseeById[l.lessee_id] || '出租中';
    }
  });
  const rentTag = (id) => (id in leasedLesseeByVehicle) ? `🔶 出租中（${leasedLesseeByVehicle[id]}）` : '自用';
  const rowAttr = (id) => (id in leasedLesseeByVehicle) ? ' style="background:#fff3cd;"' : '';

  // ---------- 1. 保險到期（車輛與板架分開，車輛在上） ----------
  const insItems = insurance.filter(i => i.expiry_date).map(attachVehicle);
  const insVehicleHtml = bucketByDate(insItems.filter(i => !i.is_trailer), 'expiry_date', i => `<tr>
    <td><b>${i.plate}</b></td><td>${i.insurance_type || ''}</td><td>${i.insurance_company || ''}</td><td>${i.expiry_date}</td><td>${daysLabel(i.expiry_date)}</td>
  </tr>`, ['車號', '險種', '保險公司', '到期日', '剩餘天數']);
  const insTrailerHtml = bucketByDate(insItems.filter(i => i.is_trailer), 'expiry_date', i => `<tr${rowAttr(i.vehicle_id)}>
    <td><b>${i.plate}</b></td><td>${rentTag(i.vehicle_id)}</td><td>${i.insurance_type || ''}</td><td>${i.insurance_company || ''}</td><td>${i.expiry_date}</td><td>${daysLabel(i.expiry_date)}</td>
  </tr>`, ['板架車號', '出租狀態', '險種', '保險公司', '到期日', '剩餘天數']);

  // ---------- 3. 人員體檢到期 ----------
  const medItems = medExams
    .filter(m => m.next_due_date)
    .map(m => ({ ...m, employee_name: employeeById[m.employee_id] || '' }));
  const medHtml = bucketByDate(medItems, 'next_due_date', m => `<tr>
    <td>${m.employee_name}</td><td>${m.next_due_date}</td><td>${daysLabel(m.next_due_date)}</td>
  </tr>`, ['姓名', '下次體檢到期日', '剩餘天數']);

  // ---------- 4. 儀器校正到期（直接用 instruments 表上的下次校正日期欄位） ----------
  // 目前持有人：優先用 instruments.current_holder_id 對回員工；
  // 有幾台舊資料沒填這欄，人名是寫在 notes 備註裡（例如「沈明逸」），就退而用備註，
  // 但像「台中備用」這種不是人名的字要排除掉，其餘一律標成「未登記」提醒補資料。
  const NOT_A_NAME = /備用|報廢|維修|保養|庫存|待|借|公用|辦公|倉|廠|站|車/;
  const holderOf = (i) => {
    const byId = employeeById[i.current_holder_id];
    if (byId) return byId;
    const note = String(i.notes || '').trim();
    if (/^[一-龥]{2,4}$/.test(note) && !NOT_A_NAME.test(note)) return `${note}（依備註）`;
    return '<span style="color:#B3261E;">⚠ 未登記</span>';
  };
  const calItems = instruments.filter(i => i.next_calibration_due);
  const calHtml = bucketByDate(calItems, 'next_calibration_due', i => `<tr>
    <td><b>${i.brand_model || ''}</b></td><td>${i.asset_no || ''}</td><td>${holderOf(i)}</td><td>${i.storage_area || ''}</td><td>${i.next_calibration_due}</td><td>${daysLabel(i.next_calibration_due)}</td>
  </tr>`, ['廠牌型號', '財產編號', '目前持有人', '存放位置', '下次校正到期日', '剩餘天數']);

  const totalCount = insItems.filter(i => daysUntil(i.expiry_date) <= 90).length
    + medItems.filter(m => daysUntil(m.next_due_date) <= 90).length
    + calItems.filter(c => daysUntil(c.next_calibration_due) <= 90).length;

  if (totalCount === 0) {
    console.log('目前沒有需要通知的其餘物品到期項目，不寄信。');
    return;
  }

  // 版面順序：先車輛（保險、文件），再板架（保險、文件），最後人員與儀器
  const bar = 'style="font-family:sans-serif;border-bottom:2px solid #9d6d2f;"';
  const groupBar = 'style="font-family:sans-serif;background:#5a4632;color:#fff;padding:8px 12px;margin:26px 0 4px;border-radius:4px;"';

  let html = `<h2 style="font-family:sans-serif;">其餘物品到期通知（${todayISO()}）</h2>`;

  if (insVehicleHtml) {
    html += `<h2 ${groupBar}>🚛 車輛</h2><h3 ${bar}>🚗 車輛保險到期</h3>${insVehicleHtml}`;
  }

  if (insTrailerHtml) {
    html += `<h2 ${groupBar}>🚚 板架</h2>
      <p style="font-family:sans-serif;font-size:13px;margin:6px 0 0;">
        <span style="background:#fff3cd;border:1px solid #d8bf6a;padding:0 14px;">&nbsp;</span>
        　黃底的列＝這台板架目前<b>出租中</b>。
      </p>
      <h3 ${bar}>🚗 板架保險到期</h3>${insTrailerHtml}`;
  }

  if (medHtml || calHtml) {
    html += `<h2 ${groupBar}>🏥 人員與儀器</h2>`;
    if (medHtml) html += `<h3 ${bar}>🏥 人員體檢到期</h3>${medHtml}`;
    if (calHtml) html += `<h3 ${bar}>🔬 儀器校正到期</h3>${calHtml}`;
  }

  html += `<p style="font-family:sans-serif;color:#888;font-size:12px;">此信由系統自動於每月1號寄送，資料來源：順亞運通車隊儀表板。驗車與行照／滅火器／濾毒罐／自主管理標章／行車記錄器等證件，已在另一份「車輛／板架／證照」通知信（每月1號、15號）裡，這裡不重複列出。</p>`;

  const recipients = NOTIFY_EMAIL.split(',').map(s => s.trim()).filter(Boolean);
  await sendEmail(RESEND_API_KEY, recipients, `【到期通知】其餘物品 共 ${totalCount} 筆項目`, html);
  console.log(`寄信成功，共 ${totalCount} 筆。`);
}

main().catch(err => {
  console.error('執行失敗:', err);
  process.exit(1);
});
