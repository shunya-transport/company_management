// 共用輔助函式：日期計算、90/60/30天分段、寄信

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}
function daysUntil(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const t = new Date(todayISO() + 'T00:00:00');
  return Math.round((d - t) / 86400000);
}

// 把剩餘天數寫成看得懂的文字
function daysLabel(dateStr) {
  const d = daysUntil(dateStr);
  if (d < 0) return `已逾期 ${-d} 天`;
  if (d === 0) return '今天到期';
  return `剩 ${d} 天`;
}

// 把一批「有到期日」的項目，依剩餘天數分成：已逾期 / 30天內 / 31~60天內 / 61~90天內
// items 需要有 expiryField 指定的日期欄位；renderRow(item) 回傳這筆的 <tr>...</tr> HTML
// headers 是選填的欄位標題陣列，例如 ['姓名','證照名稱','證照號碼','到期日']，
// 有給的話每個表格上方會多一列標題，收信的人才知道每一欄是什麼
function bucketByDate(items, expiryField, renderRow, headers) {
  const buckets = { overdue: [], within30: [], within60: [], within90: [] };
  items.forEach(item => {
    const dateVal = item[expiryField];
    if (!dateVal) return;
    const d = daysUntil(dateVal);
    if (d > 90) return; // 90天以上不列入
    if (d < 0) buckets.overdue.push(item);
    else if (d <= 30) buckets.within30.push(item);
    else if (d <= 60) buckets.within60.push(item);
    else buckets.within90.push(item);
  });
  Object.values(buckets).forEach(arr => arr.sort((a, b) => (a[expiryField] || '').localeCompare(b[expiryField] || '')));

  const headHtml = (headers && headers.length)
    ? `<tr style="background:#f2ece5;">${headers.map(h => `<th style="text-align:left;white-space:nowrap;">${h}</th>`).join('')}</tr>`
    : '';

  const sectionHtml = (title, arr, color) => {
    if (arr.length === 0) return '';
    return `<h4 style="font-family:sans-serif;color:${color};margin:14px 0 6px;">${title}（共${arr.length}筆）</h4>
      <table style="border-collapse:collapse;font-family:sans-serif;font-size:13px;width:100%;" border="1" cellpadding="6">
        ${headHtml}${arr.map(renderRow).join('')}
      </table>`;
  };

  return (
    sectionHtml('🔴 已逾期', buckets.overdue, '#B3261E') +
    sectionHtml('🟠 30天內到期', buckets.within30, '#9C6B00') +
    sectionHtml('🟡 31~60天內到期', buckets.within60, '#9C8B00') +
    sectionHtml('🟢 61~90天內到期', buckets.within90, '#4a7d3f')
  );
}

async function supaFetch(SUPABASE_URL, SUPABASE_KEY, path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
    },
  });
  if (!res.ok) {
    throw new Error(`Supabase 查詢失敗 ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

async function sendEmail(RESEND_API_KEY, recipients, subject, html) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
     from: '順亞運通系統通知 <noreply@dgtt.com.tw>',
      to: recipients,
      subject,
      html,
    }),
  });
  if (!res.ok) {
    throw new Error(`寄信失敗 ${res.status}: ${await res.text()}`);
  }
}

module.exports = { todayISO, daysUntil, daysLabel, bucketByDate, supaFetch, sendEmail };
