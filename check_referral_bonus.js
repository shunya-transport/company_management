// 每月1號執行：推薦人（介紹人）獎金提醒
// 規則讀 referral_bonus_rules（SQL_225），讀不到就用下面這組（107.11.1 起）：
//   被推薦人到職滿 6 個月 6,000、滿 12 個月 10,000、滿 18 個月 10,000，發給推薦人；
//   回鍋司機離職未滿 2 年不適用；某階段到期前就離職，那個階段起不發。
// 信裡列三段：本月到期、已到期但還沒登記發放、下個月到期（預告）。三段都沒有就不寄。
// 發放後請到儀表板「人員管理 → 編輯人員」填已發放日，下個月就不會再列。
// 收件人：REFERRAL_NOTIFY_EMAIL（沒設就用 NOTIFY_EMAIL）。
const { todayISO, supaFetchAll, sendEmail } = require('./notify_helpers');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const NOTIFY_EMAIL = process.env.REFERRAL_NOTIFY_EMAIL || process.env.NOTIFY_EMAIL;

if (!SUPABASE_URL || !SUPABASE_KEY || !RESEND_API_KEY || !NOTIFY_EMAIL) {
  console.error('缺少必要環境變數，請檢查 GitHub Secrets 設定。');
  process.exit(1);
}

const DEFAULT_RULES = [
  { effective_from: '2018-11-01', months: 6, amount: 6000, rehire_gap_days: 730 },
  { effective_from: '2018-11-01', months: 12, amount: 10000, rehire_gap_days: 730 },
  { effective_from: '2018-11-01', months: 18, amount: 10000, rehire_gap_days: 730 },
];

const esc = (v) => String(v == null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const money = (v) => Number(v || 0).toLocaleString('en-US');

function addMonths(iso, n) {
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return '';
  const t = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  const p = (v) => String(v).padStart(2, '0');
  return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(Math.min(d, last))}`;
}
function rulesFor(all, startISO) {
  const ok = all.filter((r) => String(r.effective_from || '').slice(0, 10) <= startISO);
  if (!ok.length) return [];
  const eff = ok.map((r) => String(r.effective_from).slice(0, 10)).sort().pop();
  return ok.filter((r) => String(r.effective_from).slice(0, 10) === eff)
    .map((r) => ({ months: Number(r.months), amount: Number(r.amount), gap: Number(r.rehire_gap_days) || 730 }))
    .sort((a, b) => a.months - b.months);
}
function paidMap(e) {
  let p = e.referral_paid;
  if (typeof p === 'string') { try { p = JSON.parse(p); } catch (_) { p = null; } }
  return p && typeof p === 'object' ? p : {};
}

async function main() {
  const today = todayISO();
  const thisMonth = today.slice(0, 7);
  const nextMonth = addMonths(today.slice(0, 8) + '01', 1).slice(0, 7);
  console.log('開始檢查推薦獎金...', today);

  let rules = [];
  try { rules = await supaFetchAll(SUPABASE_URL, SUPABASE_KEY, 'referral_bonus_rules?select=*'); } catch (e) {
    console.warn('referral_bonus_rules 讀不到，用內建規則', e.message);
  }
  if (!rules.length) rules = DEFAULT_RULES;

  const [employees, history] = await Promise.all([
    supaFetchAll(SUPABASE_URL, SUPABASE_KEY, 'employees?select=*,companies(company_name)&referrer_name=not.is.null'),
    supaFetchAll(SUPABASE_URL, SUPABASE_KEY, 'employees_history?select=*'),
  ]);
  const people = employees.map((e) => ({ e, left: false }))
    .concat(history.filter((h) => String(h.referrer_name || '').trim()).map((e) => ({ e, left: true })));

  const items = [];
  people.forEach(({ e, left }) => {
    const ref = String(e.referrer_name || '').trim();
    if (!ref) return;
    const start = String(e.rehire_date || e.hire_date || '').slice(0, 10);
    if (!start) return;
    const rs = rulesFor(rules, start);
    if (!rs.length) return;
    if (/^不適用/.test(String(e.referral_note || '').trim())) return;
    const prev = history.filter((h) => String(h.name || '').trim() === String(e.name || '').trim())
      .map((h) => String(h.resign_date || '').slice(0, 10)).filter((d) => d && d < start).sort().pop();
    if (prev && (new Date(start) - new Date(prev)) / 86400000 < rs[0].gap) return;   // 回鍋未滿 2 年
    const resign = left ? String(e.resign_date || '').slice(0, 10) : '';
    const paid = paidMap(e);
    const company = (e.companies && e.companies.company_name) || e.company_name || '';
    rs.forEach((r) => {
      const due = addMonths(start, r.months);
      if (paid[r.months] || paid[String(r.months)]) return;
      if (resign && resign < due) return;
      let bucket = '';
      if (due.slice(0, 7) === thisMonth) bucket = 'month';
      else if (due < today) bucket = 'over';
      else if (due.slice(0, 7) === nextMonth) bucket = 'next';
      if (!bucket) return;
      items.push({ bucket, referrer: ref, referee: e.name || '', left, company, start, months: r.months, due, amount: r.amount });
    });
  });

  const of = (b) => items.filter((i) => i.bucket === b).sort((a, b2) => a.due.localeCompare(b2.due));
  const month = of('month'), over = of('over'), next = of('next');
  if (!month.length && !over.length && !next.length) {
    console.log('本月沒有推薦獎金要提醒，不寄信。');
    return;
  }

  const head = '<tr style="background:#f2ece5;"><th align="left">推薦人</th><th align="left">被推薦人</th><th align="left">行號</th>'
    + '<th align="left">到職日</th><th align="left">階段</th><th align="left">到期日</th><th align="right">金額</th></tr>';
  const table = (arr) => `<table style="border-collapse:collapse;font-family:sans-serif;font-size:13px;width:100%;" border="1" cellpadding="6">
    ${head}${arr.map((i) => `<tr><td><b>${esc(i.referrer)}</b></td><td>${esc(i.referee)}${i.left ? '（已離職）' : ''}</td>
      <td>${esc(i.company)}</td><td>${esc(i.start)}</td><td>滿 ${i.months} 個月</td><td>${esc(i.due)}</td>
      <td align="right">${money(i.amount)}</td></tr>`).join('')}
    <tr><td colspan="6" align="right"><b>小計</b></td><td align="right"><b>${money(arr.reduce((s, i) => s + i.amount, 0))}</b></td></tr>
  </table>`;

  // 各推薦人這個月要發多少（本月到期＋已到期待發）
  const byRef = {};
  month.concat(over).forEach((i) => { byRef[i.referrer] = (byRef[i.referrer] || 0) + i.amount; });
  const refRows = Object.keys(byRef).sort((a, b) => byRef[b] - byRef[a])
    .map((k) => `<tr><td>${esc(k)}</td><td align="right">${money(byRef[k])}</td></tr>`).join('');

  const [y, m] = thisMonth.split('-').map(Number);
  const rocLabel = `${y - 1911} 年 ${m} 月`;
  const bar = 'style="font-family:sans-serif;border-bottom:2px solid #9d6d2f;"';
  let html = `<h2 style="font-family:sans-serif;">推薦人（介紹人）獎金提醒　${rocLabel}</h2>`;
  if (refRows) {
    html += `<h3 ${bar}>💰 本月各推薦人應發金額</h3>
      <table style="border-collapse:collapse;font-family:sans-serif;font-size:13px;" border="1" cellpadding="6">
        <tr style="background:#f2ece5;"><th align="left">推薦人</th><th align="right">金額</th></tr>${refRows}
        <tr><td><b>合計</b></td><td align="right"><b>${money(Object.values(byRef).reduce((a, b) => a + b, 0))}</b></td></tr>
      </table>`;
  }
  if (month.length) html += `<h3 ${bar}>🟠 本月到期（共 ${month.length} 筆）</h3>${table(month)}`;
  if (over.length) {
    html += `<h3 ${bar}>🔴 已到期・尚未登記發放（共 ${over.length} 筆）</h3>
      <p style="font-family:sans-serif;font-size:12.5px;color:#666;margin:4px 0;">可能是以前已經發過、只是系統沒登記，請核對後到「人員管理 → 編輯人員」補填已發放日。</p>${table(over)}`;
  }
  if (next.length) html += `<h3 ${bar}>🟢 下個月到期（預告，共 ${next.length} 筆）</h3>${table(next)}`;
  html += `<p style="font-family:sans-serif;color:#888;font-size:12px;">此信由系統自動於每月1號寄送。規則：被推薦人到職滿 6 個月 6,000、12 個月 10,000、18 個月 10,000（以 referral_bonus_rules 為準）；回鍋司機離職未滿 2 年不適用；到期前離職不發。完整清單：儀表板「表單生成 → 推薦人（介紹人）獎金表」。</p>`;

  const recipients = NOTIFY_EMAIL.split(',').map((s) => s.trim()).filter(Boolean);
  const subject = `【推薦獎金提醒】${rocLabel}　本月到期 ${month.length} 筆` + (over.length ? `、待發 ${over.length} 筆` : '');
  await sendEmail(RESEND_API_KEY, recipients, subject, html);
  console.log(`寄信成功：本月 ${month.length}、待發 ${over.length}、下月 ${next.length}`);
}

main().catch((err) => {
  console.error('執行失敗:', err);
  process.exit(1);
});
