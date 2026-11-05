// 線上請假的通知信（SQL_241 的 leave_notifications 佇列）
// 資料庫在送出、每一關核准、駁回、撤回時把「要寄給誰」排進佇列；這支每 10 分鐘跑一次，
// 把 pending 的逐封寄出，寄完標成 sent（失敗標 failed 並記下原因，不會一直重寄）。
// 需要的 Secrets 跟其他通知信一樣：SUPABASE_URL、SUPABASE_KEY（service_role）、RESEND_API_KEY。
const { sendEmail } = require('./notify_helpers');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY || !RESEND_API_KEY) {
  console.error('缺少必要環境變數，請檢查 GitHub Secrets 設定。');
  process.exit(1);
}

const H = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' };
async function get(path) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: H });
  if (!r.ok) throw new Error(`Supabase 查詢失敗 ${r.status}: ${await r.text()}`);
  return r.json();
}
async function patch(path, body) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { method: 'PATCH', headers: H, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`Supabase 更新失敗 ${r.status}: ${await r.text()}`);
}
const esc = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const roc = (d) => { const m = String(d || '').slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/); return m ? `${m[1] - 1911}/${m[2]}/${m[3]}` : ''; };
const dates = (r) => roc(r.start_date) + (r.end_date !== r.start_date ? '～' + roc(r.end_date) : '');
const hrs = (r) => `${Number(r.hours)} 小時`;

function build(n, r, acts, site, recNo) {
  const st = (r.stages || [])[r.current_stage - 1] || {};
  const last = acts.filter((a) => a.request_id === r.request_id).slice(-1)[0] || {};
  const head = `${r.name}　${r.leave_type}　${hrs(r)}（${dates(r)}）`;
  const link = site ? `<p><a href="${esc(site)}">開啟線上請假</a></p>` : '';
  const trail = acts.filter((a) => a.request_id === r.request_id)
    .map((a) => `<li>${esc(a.stage_name || '')}　${esc(a.action)}　${esc(a.actor_name || '')}${a.comment ? '：' + esc(a.comment) : ''}</li>`).join('');
  const detail = `<table style="border-collapse:collapse;font-family:sans-serif;font-size:14px;" border="1" cellpadding="6">
      <tr><td>申請人</td><td>${esc(r.name)}（${esc(r.emp_no || '')}　${esc(r.region || '')}）</td></tr>
      <tr><td>假別</td><td>${esc(r.leave_type)}</td></tr><tr><td>日期</td><td>${esc(dates(r))}</td></tr>
      <tr><td>時數</td><td>${esc(hrs(r))}</td></tr><tr><td>事由</td><td>${esc(r.reason || '—')}</td></tr>
      <tr><td>假單編號</td><td>#${r.request_id}</td></tr></table>
    ${trail ? `<p style="font-family:sans-serif;font-size:13px;">簽核紀錄：</p><ul style="font-family:sans-serif;font-size:13px;">${trail}</ul>` : ''}`;
  const foot = '<p style="font-family:sans-serif;color:#888;font-size:12px;">此信由順亞運通線上請假系統自動寄出，請勿直接回信。</p>';
  const ev = n.event;
  if (ev === 'submitted' || ev === 'advanced') {
    return { subject: `【請假待簽】${head}`,
      html: `<h3 style="font-family:sans-serif;">有一張假單等您簽核（${esc(st.name || '')}）</h3>${detail}${link}${foot}` };
  }
  if (ev === 'submitted_admin' || ev === 'advanced_admin') {
    const why = st.name === '行政確認' ? '這張假單的簽核路線上沒有其他人（例如總經理本人請假），需要行政代登核准。'
      : `這一關（${st.name || ''}）的簽核人沒有登記通知信箱，請轉告本人到請假網頁簽${(st.approver_names || []).length ? '（' + (st.approver_names || []).join('、') + '）' : ''}。`;
    return { subject: `【請假待確認】${head}`,
      html: `<h3 style="font-family:sans-serif;">${esc(why)}</h3>${detail}<p style="font-family:sans-serif;">請到運輸行政管理資料庫「請假管理 → 請假簽核設定」處理。</p>${foot}` };
  }
  if (ev === 'approved') {
    return { subject: `【請假已核准】${r.leave_type} ${hrs(r)}（${dates(r)}）`,
      html: `<h3 style="font-family:sans-serif;">您的假單已核准</h3>${detail}${link}${foot}` };
  }
  if (ev === 'approved_admin') {
    return { subject: `【請假核准通知】${head}`,
      html: `<h3 style="font-family:sans-serif;">假單已核准，已自動寫入請假紀錄${recNo ? '（' + esc(recNo) + '）' : ''}</h3>${detail}${foot}` };
  }
  if (ev === 'rejected') {
    return { subject: `【請假駁回】${r.leave_type} ${hrs(r)}（${dates(r)}）`,
      html: `<h3 style="font-family:sans-serif;">您的假單被駁回</h3><p style="font-family:sans-serif;">原因：${esc(last.comment || '')}</p>${detail}${link}${foot}` };
  }
  if (ev === 'proxied_ok' || ev === 'proxied_no') {
    const what = ev === 'proxied_ok' ? '核准' : '駁回';
    const mine = acts.filter((a) => a.request_id === r.request_id && a.by_staff).slice(-1)[0] || {};
    return { subject: `【行政代登${what}】${head}`,
      html: `<h3 style="font-family:sans-serif;">行政已代您${what}這張假單（${esc(mine.stage_name || '')}）</h3>`
        + `<p style="font-family:sans-serif;">如果不是您同意的，請直接聯絡行政。</p>${detail}${link}${foot}` };
  }
  if (ev === 'cancelled' || ev === 'cancelled_admin') {
    return { subject: `【假單已撤回】${head}`,
      html: `<h3 style="font-family:sans-serif;">申請人已撤回這張假單，不用再簽</h3>${detail}${foot}` };
  }
  return null;
}

async function main() {
  const pend = await get('leave_notifications?status=eq.pending&order=notify_id.asc&limit=300');
  if (!pend.length) { console.log('沒有要寄的請假通知。'); return; }
  const ids = [...new Set(pend.map((n) => n.request_id).filter(Boolean))];
  const reqs = ids.length ? await get(`leave_requests?select=*&request_id=in.(${ids.join(',')})`) : [];
  const acts = ids.length ? await get(`leave_request_actions?select=*&request_id=in.(${ids.join(',')})&order=acted_at.asc`) : [];
  const recIds = reqs.map((r) => r.leave_record_id).filter(Boolean);
  const recs = recIds.length ? await get(`leave_records?select=record_id,reg_no&record_id=in.(${recIds.join(',')})`).catch(() => []) : [];
  const sets = await get('leave_settings?select=*').catch(() => []);
  const site = (sets.find((s) => s.key === 'site_url') || {}).value || '';
  const seen = new Set();
  let sent = 0, failed = 0;
  for (const n of pend) {
    const key = `${n.request_id}|${n.event}|${String(n.to_email || '').toLowerCase()}`;
    const r = reqs.find((x) => x.request_id === n.request_id);
    if (!n.to_email || !r || seen.has(key)) {
      await patch(`leave_notifications?notify_id=eq.${n.notify_id}`, { status: 'skipped', error: !r ? '找不到假單' : (!n.to_email ? '沒有信箱' : '重複'), sent_at: new Date().toISOString() });
      continue;
    }
    seen.add(key);
    const rec = recs.find((x) => x.record_id === r.leave_record_id);
    const mail = build(n, r, acts, site, rec && rec.reg_no);
    if (!mail) { await patch(`leave_notifications?notify_id=eq.${n.notify_id}`, { status: 'skipped', error: '不認得的事件' }); continue; }
    try {
      await sendEmail(RESEND_API_KEY, [n.to_email], mail.subject, mail.html);
      await patch(`leave_notifications?notify_id=eq.${n.notify_id}`, { status: 'sent', sent_at: new Date().toISOString() });
      sent++;
    } catch (e) {
      await patch(`leave_notifications?notify_id=eq.${n.notify_id}`, { status: 'failed', error: String(e.message).slice(0, 400) });
      failed++;
    }
    await new Promise((res) => setTimeout(res, 600));   // Resend 每秒最多 2 封
  }
  console.log(`請假通知：寄出 ${sent} 封、失敗 ${failed} 封。`);
}

main().catch((err) => { console.error('執行失敗:', err); process.exit(1); });
