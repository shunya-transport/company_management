// 共用輔助函式：日期計算、90/60/30天分段、寄信

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}
function daysUntil(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const t = new Date(todayISO() + 'T00:00:00');
  return Math.round((d - t) / 86400000);
}

// 把一批「有到期日」的項目，依剩餘天數分成：已逾期 / 30天內 / 31~60天內 / 61~90天內
// items 需要有 expiryField 指定的日期欄位；renderRow(item) 回傳這筆的 <tr>...</tr> HTML
function bucketByDate(items, expiryField, renderRow) {
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

  const sectionHtml = (title, arr, color) => {
    if (arr.length === 0) return '';
    return `<h4 style="font-family:sans-serif;color:${color};margin:14px 0 6px;">${title}（共${arr.length}筆）</h4>
      <table style="border-collapse:collapse;font-family:sans-serif;font-size:13px;width:100%;" border="1" cellpadding="6">
        ${arr.map(renderRow).join('')}
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
      from: 'onboarding@resend.dev',
      to: recipients,
      subject,
      html,
    }),
  });
  if (!res.ok) {
    throw new Error(`寄信失敗 ${res.status}: ${await res.text()}`);
  }
}

module.exports = { todayISO, daysUntil, bucketByDate, supaFetch, sendEmail };
