// 從 Supabase 撈出所有資料，打包成備份 zip 寄到信箱。
//
// 有兩種模式，靠環境變數 BACKUP_MODE 切換：
//   daily（每天早上跑）— 只備「資料」：CSV、還原用 SQL、SQLite 檔。檔案小，適合天天寄。
//   full （每月5號跑）— 連儀表板網頁、通知程式、歷次 SQL 指令一起打包，是完整的一份。
// 沒設 BACKUP_MODE 就是 full，維持原本的行為。
//
// 設計上的兩個重點：
// 1. 資料一律從 Supabase 雲端撈，因為那才是同事每天在用的、最新的資料。
// 2. 儀表板、通知程式、SQL 指令直接取自這個 repo 的檔案（GitHub Actions 會先 checkout），
//    所以備份裡的程式版本，就是當下線上跑的那一版。
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const BACKUP_EMAIL = process.env.BACKUP_EMAIL || process.env.NOTIFY_EMAIL;

if (!SUPABASE_URL || !SUPABASE_KEY || !RESEND_API_KEY || !BACKUP_EMAIL) {
  console.error('缺少必要環境變數，請檢查 GitHub Secrets 設定。');
  process.exit(1);
}

const IS_DAILY = String(process.env.BACKUP_MODE || 'full').toLowerCase() === 'daily';
const 模式名稱 = IS_DAILY ? '每日資料' : '每月完整';

const PAGE = 1000;               // PostgREST 一次最多回 1000 筆，超過要分頁撈
const MAX_ATTACH_MB = 30;        // 超過這個大小就不夾檔，改寄一封提醒信
const today = new Date().toISOString().slice(0, 10);
const OUT = path.join(process.cwd(), 'backup_out');
const ZIP = path.join(process.cwd(), `shunya_backup_${IS_DAILY ? 'daily' : 'full'}_${today}.zip`);

async function api(pathAndQuery) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${pathAndQuery}`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  });
  if (!res.ok) throw new Error(`Supabase 查詢失敗 ${res.status} (${pathAndQuery}): ${await res.text()}`);
  return res.json();
}

// 有哪些資料表？直接問 PostgREST 的 API 說明檔，這樣日後新增資料表也會自動被備份到，
// 不用回來改這支程式。萬一問不到就退回用已知的清單。
const FALLBACK_TABLES = [
  'employees', 'employees_history', 'vehicles', 'vehicle_documents', 'vehicle_insurance',
  'vehicle_mileage_logs', 'vehicle_equipment', 'maintenance_schedules', 'maintenance_records',
  'maintenance_items', 'trailer_leases', 'lessees', 'employee_trainings', 'training_types',
  'training_log', 'internal_trainings', 'medical_exam_records', 'instruments',
];
async function listTables() {
  try {
    const spec = await api('');
    const names = Object.keys(spec.definitions || spec.components?.schemas || {});
    if (names.length) return names.sort();
    const fromPaths = Object.keys(spec.paths || {})
      .filter(p => p.startsWith('/') && p.length > 1 && !p.includes('{') && !p.startsWith('/rpc'))
      .map(p => p.slice(1));
    if (fromPaths.length) return [...new Set(fromPaths)].sort();
  } catch (e) {
    console.warn('自動偵測資料表失敗，改用內建清單：', e.message);
  }
  return FALLBACK_TABLES;
}

async function fetchAll(table) {
  const rows = [];
  for (let offset = 0; ; offset += PAGE) {
    const batch = await api(`${table}?select=*&limit=${PAGE}&offset=${offset}`);
    rows.push(...batch);
    if (batch.length < PAGE) break;
  }
  return rows;
}

// ---------- 輸出格式 ----------
const cellToText = (v) => {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
};
const csvEscape = (v) => {
  const s = cellToText(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
function writeCsv(file, cols, rows) {
  const lines = [cols.map(csvEscape).join(',')];
  rows.forEach(r => lines.push(cols.map(c => csvEscape(r[c])).join(',')));
  // 開頭加 BOM，Excel 打開中文才不會變亂碼
  fs.writeFileSync(file, '﻿' + lines.join('\r\n'));
}

const sqlLiteral = (v, dialect) => {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return dialect === 'sqlite' ? (v ? '1' : '0') : (v ? 'true' : 'false');
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return `'${s.replace(/'/g, "''")}'`;
};

// SQLite 沒有型別檢查，但還是照資料猜一下欄位型別，日後用 DB Browser 打開排序才正常
function guessType(rows, col) {
  let seen = false, allInt = true, allNum = true;
  for (const r of rows) {
    const v = r[col];
    if (v === null || v === undefined) continue;
    seen = true;
    if (typeof v !== 'number') { allInt = false; allNum = false; break; }
    if (!Number.isInteger(v)) allInt = false;
  }
  if (!seen) return 'TEXT';
  return allInt ? 'INTEGER' : allNum ? 'REAL' : 'TEXT';
}

function columnsOf(rows) {
  const cols = [];
  rows.forEach(r => Object.keys(r).forEach(k => { if (!cols.includes(k)) cols.push(k); }));
  return cols;
}

async function build() {
  fs.rmSync(OUT, { recursive: true, force: true });
  // 每日備份只留資料夾 01，信箱和雲端硬碟才不會被每天一模一樣的網頁塞爆
  const dirs = IS_DAILY
    ? ['01_資料庫', '01_資料庫/CSV各資料表']
    : ['01_資料庫', '01_資料庫/CSV各資料表', '02_儀表板網頁', '03_通知程式', '04_SQL指令'];
  dirs.forEach(d => fs.mkdirSync(path.join(OUT, d), { recursive: true }));

  const tables = await listTables();
  console.log(`偵測到 ${tables.length} 張資料表，開始備份...`);

  const pgLines = [
    '-- 順亞運通管理系統 Supabase 資料備份',
    `-- 備份日期：${today}`,
    '-- 用法：整份貼進 Supabase 後台的 SQL Editor 執行即可。',
    '-- 下面這行是暫時關閉外鍵檢查，讓資料可以不管先後順序灌回去；',
    '-- 如果這一行執行時報權限錯誤，把它和最後那行對應的還原指令一起刪掉，再執行一次通常就過了。',
    "SET session_replication_role = 'replica';",
    'BEGIN;',
    '',
  ];
  const liteLines = ['PRAGMA foreign_keys=OFF;', 'BEGIN TRANSACTION;', ''];
  const summary = [];
  let totalRows = 0, failed = [];

  for (const t of tables) {
    let rows;
    try {
      rows = await fetchAll(t);
    } catch (e) {
      console.warn(`  跳過 ${t}：${e.message}`);
      failed.push(t);
      continue;
    }
    summary.push({ 資料表: t, 筆數: rows.length });
    totalRows += rows.length;
    if (!rows.length) continue;

    const cols = columnsOf(rows);
    writeCsv(path.join(OUT, '01_資料庫/CSV各資料表', `${t}.csv`), cols, rows);

    const colList = cols.map(c => `"${c}"`).join(', ');
    pgLines.push(`-- ${t}（${rows.length} 筆）`, `DELETE FROM "${t}";`);
    liteLines.push(`DROP TABLE IF EXISTS "${t}";`,
      `CREATE TABLE "${t}" (${cols.map(c => `"${c}" ${guessType(rows, c)}`).join(', ')});`);
    rows.forEach(r => {
      pgLines.push(`INSERT INTO "${t}" (${colList}) VALUES (${cols.map(c => sqlLiteral(r[c], 'pg')).join(', ')});`);
      liteLines.push(`INSERT INTO "${t}" (${colList}) VALUES (${cols.map(c => sqlLiteral(r[c], 'sqlite')).join(', ')});`);
    });
    pgLines.push('');
    liteLines.push('');
    console.log(`  ${t}：${rows.length} 筆`);
  }
  pgLines.push('COMMIT;', "SET session_replication_role = 'origin';  -- 把外鍵檢查恢復回來");
  liteLines.push('COMMIT;');

  fs.writeFileSync(path.join(OUT, '01_資料庫/Supabase還原用_完整匯出.sql'), pgLines.join('\n'));
  const litePath = path.join(OUT, '01_資料庫/SQLite建檔用.sql');
  fs.writeFileSync(litePath, liteLines.join('\n'));

  summary.sort((a, b) => b.筆數 - a.筆數);
  writeCsv(path.join(OUT, '01_資料庫/資料表筆數清單.csv'), ['資料表', '筆數'], summary);

  // 順便組一個 SQLite 檔，習慣用 DB Browser 看的人可以直接打開。失敗也不影響其他備份內容。
  try {
    const dbPath = path.join(OUT, '01_資料庫/company_management.db');
    execFileSync('sqlite3', [dbPath], { input: fs.readFileSync(litePath), stdio: ['pipe', 'ignore', 'pipe'] });
    console.log('SQLite 檔已產生');
  } catch (e) {
    console.warn('SQLite 檔產生失敗（不影響 SQL 與 CSV 備份）：', String(e.message || e).slice(0, 200));
  }

  // repo 裡的網頁與程式：備份的是這一刻線上實際在跑的版本
  const copy = (src, destDir) => {
    if (!fs.existsSync(src)) return false;
    fs.copyFileSync(src, path.join(OUT, destDir, path.basename(src)));
    return true;
  };
  let fileCount = 0;
  // 每日備份不重複打包網頁與程式：那些每天都一樣，而且 GitHub 上本來就有版本紀錄
  if (!IS_DAILY) {
   fs.readdirSync(process.cwd()).forEach(f => {
    if (f.endsWith('.html')) fileCount += copy(f, '02_儀表板網頁') ? 1 : 0;
    else if (f.endsWith('.js') && f !== 'backup_monthly.js') fileCount += copy(f, '03_通知程式') ? 1 : 0;
    else if (f.endsWith('.json') && f !== 'package.json') fileCount += copy(f, '03_通知程式') ? 1 : 0;
    else if (f.endsWith('.sql')) fileCount += copy(f, '04_SQL指令') ? 1 : 0;
  });
  if (fs.existsSync('.github/workflows')) {
    const wf = path.join(OUT, '03_通知程式/GitHub_Actions設定檔');
    fs.mkdirSync(wf, { recursive: true });
    fs.readdirSync('.github/workflows').forEach(f => {
      fs.copyFileSync(path.join('.github/workflows', f), path.join(wf, f));
      fileCount++;
    });
   }
  }

  const readme = `# 順亞運通管理系統 自動備份（${模式名稱}）

備份日期：${today}
資料來源：Supabase 雲端資料庫（同事每天實際在用的那一份）
資料規模：${summary.length} 張資料表、共 ${totalRows.toLocaleString('en-US')} 筆
${IS_DAILY
  ? '這是每日備份，只含資料。儀表板網頁與程式請看每月5號那份完整備份。'
  : `隨附程式檔：${fileCount} 個`}${failed.length ? `\n讀取失敗的資料表：${failed.join('、')}（請檢查權限設定）` : ''}

## 這包裡面有什麼

01_資料庫
  company_management.db     SQLite 檔，用 DB Browser for SQLite 直接打開就能查
  Supabase還原用_完整匯出.sql  雲端資料出問題時，貼進 Supabase SQL Editor 執行即可還原
  SQLite建檔用.sql            上面那個 .db 檔的建檔語法，備而不用
  CSV各資料表/               每張表一個 CSV，Excel 雙擊就能開，中文不會亂碼
  資料表筆數清單.csv          對一下筆數就知道備份有沒有缺東西
${IS_DAILY ? '' : `
02_儀表板網頁                五個儀表板的當月版本，瀏覽器直接開
03_通知程式                  到期通知程式與 GitHub Actions 排程設定檔
04_SQL指令                   歷次在 Supabase 執行過的指令`}

## 要還原的時候

雲端資料出問題：到 Supabase 後台 SQL Editor，貼上「Supabase還原用_完整匯出.sql」執行。
執行完記得再跑一次「修復service_role權限.sql」（在每月完整備份的 04_SQL指令 資料夾裡），
因為重建資料之後權限要重新授權，不然到期通知信會讀不到資料。

只想救回某一張表：用 CSV各資料表 裡對應的檔案匯入就好，不必整個重建。

## 提醒

這包含完整的員工個資與投保資料，請留在自己的信箱或雲端硬碟，不要放到公開的 GitHub 儲存庫。
`;
  fs.writeFileSync(path.join(OUT, '00_備份說明.md'), readme);

  fs.rmSync(ZIP, { force: true });
  execFileSync('zip', ['-r', '-q', ZIP, path.basename(OUT)], { cwd: process.cwd() });
  let mb = fs.statSync(ZIP).size / 1024 / 1024;
  let trimmed = false;
  // 萬一哪天資料長太大、信件夾不下，就先捨棄儀表板網頁（那些 GitHub 上本來就有版本紀錄），
  // 保住最重要的資料庫備份，總比整封信寄不出去好。
  if (mb > MAX_ATTACH_MB) {
    console.warn(`備份 ${mb.toFixed(1)} MB 超過上限，改為只打包資料庫部分`);
    fs.rmSync(path.join(OUT, '02_儀表板網頁'), { recursive: true, force: true });
    fs.rmSync(ZIP, { force: true });
    execFileSync('zip', ['-r', '-q', ZIP, path.basename(OUT)], { cwd: process.cwd() });
    mb = fs.statSync(ZIP).size / 1024 / 1024;
    trimmed = true;
  }
  console.log(`打包完成：${path.basename(ZIP)}（${mb.toFixed(1)} MB）`);
  return { tables: summary.length, totalRows, fileCount, mb, failed, trimmed };
}

async function sendMail(stat) {
  const tooBig = stat.mb > MAX_ATTACH_MB;
  const recipients = BACKUP_EMAIL.split(',').map(s => s.trim()).filter(Boolean);
  const warn = (stat.failed.length
    ? `<p style="font-family:sans-serif;color:#B3261E;">有 ${stat.failed.length} 張資料表這次讀不到（${stat.failed.join('、')}），請檢查 Supabase 權限設定。</p>`
    : '')
    + (stat.trimmed
      ? '<p style="font-family:sans-serif;color:#9C6B00;">備份檔偏大，這次省略了儀表板網頁，只保留資料庫部分（網頁在 GitHub 上有版本紀錄，可另外取得）。</p>'
      : '');
  const html = `<h2 style="font-family:sans-serif;">順亞運通管理系統 ${模式名稱}備份（${today}）</h2>
    <p style="font-family:sans-serif;font-size:14px;">
      ${IS_DAILY
        ? '這是系統每天自動產生的資料備份，直接取自 Supabase 雲端資料庫。'
        : '這是系統每月自動產生的完整備份，資料直接取自 Supabase 雲端資料庫。'}<br>
      資料表 <b>${stat.tables}</b> 張、資料 <b>${stat.totalRows.toLocaleString('en-US')}</b> 筆、
      ${IS_DAILY ? '' : `隨附儀表板與程式檔 <b>${stat.fileCount}</b> 個、`}壓縮檔 <b>${stat.mb.toFixed(1)} MB</b>。
    </p>
    ${warn}
    ${tooBig
      ? `<p style="font-family:sans-serif;color:#B3261E;">備份檔仍超過 ${MAX_ATTACH_MB} MB，這封信夾不了檔案。請聯絡系統維護人員手動取一份。</p>`
      : `<p style="font-family:sans-serif;font-size:14px;">備份檔就附在這封信裡（${path.basename(ZIP)}），解開後先看「00_備份說明.md」。</p>`}
    <p style="font-family:sans-serif;color:#888;font-size:12px;">
      此信由系統自動於${IS_DAILY ? '每天早上' : '每月5號'}寄送。內含員工個資與投保資料，請勿轉寄或上傳到公開網路空間。
    </p>`;

  const body = {
    from: '順亞運通系統通知 <noreply@dgtt.com.tw>',
    to: recipients,
    subject: `【備份】順亞運通管理系統 ${模式名稱} ${today}`,
    html,
  };
  if (!tooBig) {
    body.attachments = [{
      filename: path.basename(ZIP),
      content: fs.readFileSync(ZIP).toString('base64'),
    }];
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`寄信失敗 ${res.status}: ${await res.text()}`);
  console.log(`${模式名稱}備份信已寄出給 ${recipients.join('、')}`);
}

(async () => {
  const stat = await build();
  await sendMail(stat);
})().catch(err => {
  console.error('備份失敗:', err);
  process.exit(1);
});
