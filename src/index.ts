import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";
import { GoogleHandler } from "./google-handler";

// === TIPE ==============================================
type Props = { name: string; email: string; accessToken: string };
type Receipt = {
  total_money: number;
  line_items: { item_name: string; quantity: number; total_money: number; cost_total: number }[];
  created_at: string;
};
type TopItem = [string, { qty: number; omzet: number }];

// === MCP SERVER ========================================
export class MyMCP extends McpAgent<Env, Record<string, never>, Props> {
  server = new McpServer({ name: "Loyverse MCP", version: "0.0.1" });

  async init() {
    const getToken = (store: "kasir1" | "kasir2") =>
      store === "kasir2" ? this.env.LOYVERSE_API_TOKEN_2 : this.env.LOYVERSE_API_TOKEN;

    this.server.tool("get_recent_receipts", "Ambil daftar transaksi terbaru", {
      store: z.enum(["kasir1", "kasir2"]).default("kasir1"),
      limit: z.number().min(1).max(50).default(10),
    }, async ({ store, limit }) => {
      const res = await fetch(`https://api.loyverse.com/v1.0/receipts?limit=${limit}`, {
        headers: { Authorization: `Bearer ${getToken(store)}` },
      });
      const data = await res.json();
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    });

    this.server.tool("get_sales_summary", "Rekap penjualan dalam rentang tanggal", {
      store: z.enum(["kasir1", "kasir2"]).default("kasir1"),
      from: z.string().describe("YYYY-MM-DD"),
      to: z.string().describe("YYYY-MM-DD"),
    }, async ({ store, from, to }) => {
      const { fromISO, toISO } = dateStrToISORangeWIB(from, to);
      const receipts = await fetchAllReceipts(getToken(store), fromISO, toISO);
      const s = summarize(receipts);
      return { content: [{ type: "text", text: JSON.stringify(s, null, 2) }] };
    });

    this.server.tool("list_loyverse_items", "Ambil daftar produk", {
      store: z.enum(["kasir1", "kasir2"]).default("kasir1"),
      limit: z.number().min(1).max(50).default(20),
    }, async ({ store, limit }) => {
      const res = await fetch(`https://api.loyverse.com/v1.0/items?limit=${limit}`, {
        headers: { Authorization: `Bearer ${getToken(store)}` },
      });
      const data = await res.json();
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    });
  }
}

// === FUNGSI BANTU ======================================
function dateStrToISORangeWIB(fromDateStr: string, toDateStr: string) {
  const fromISO = new Date(`${fromDateStr}T00:00:00+07:00`).toISOString();
  const toISO = new Date(`${toDateStr}T23:59:59+07:00`).toISOString();
  return { fromISO, toISO };
}

function addDaysToDateStr(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00+07:00`);
  d.setDate(d.getDate() + days);
  return d.toISOString().split("T")[0];
}

function addMonthsToDateStr(dateStr: string, months: number): string {
  const d = new Date(`${dateStr}T00:00:00+07:00`);
  d.setMonth(d.getMonth() + months);
  return d.toISOString().split("T")[0];
}

function getYesterdayDateStr(): string {
  const now = new Date();
  const wibNow = new Date(now.getTime() + 7 * 60 * 60 * 1000);
  const target = new Date(wibNow.getTime() - 24 * 60 * 60 * 1000);
  return target.toISOString().split("T")[0];
}

function getTodayDateStr(): string {
  const now = new Date();
  const wibNow = new Date(now.getTime() + 7 * 60 * 60 * 1000);
  return wibNow.toISOString().split("T")[0];
}

function getFirstDayOfMonth(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00+07:00`);
  d.setDate(1);
  return d.toISOString().split("T")[0];
}

function getLastDayOfMonth(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00+07:00`);
  d.setMonth(d.getMonth() + 1);
  d.setDate(0);
  return d.toISOString().split("T")[0];
}

function isMoreThan31Days(fromDateStr: string, toDateStr: string): boolean {
  const from = new Date(`${fromDateStr}T00:00:00+07:00`);
  const to = new Date(`${toDateStr}T00:00:00+07:00`);
  const diffTime = Math.abs(to.getTime() - from.getTime());
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  return diffDays > 31;
}

// === FETCH DENGAN PAGINATION ===========================
async function fetchAllReceipts(token: string, fromISO: string, toISO: string): Promise<Receipt[]> {
  let all: Receipt[] = [];
  let cursor: string | null = null;
  const limit = 250;
  let iteration = 0;
  const MAX_ITER = 50;

  do {
    iteration++;
    if (iteration > MAX_ITER) break;

    let url = `https://api.loyverse.com/v1.0/receipts?limit=${limit}&created_at_min=${encodeURIComponent(fromISO)}&created_at_max=${encodeURIComponent(toISO)}`;
    if (cursor) url += `&cursor=${cursor}`;

    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) break;
    const data: any = await res.json();
    if (!data.receipts || data.receipts.length === 0) break;

    all = all.concat(data.receipts);
    cursor = data.cursor || null;
  } while (cursor);

  return all;
}

// === SUMMARIZE =========================================
function summarize(receipts: Receipt[]) {
  let omzet = 0, laba = 0;
  const itemMap: Record<string, { qty: number; omzet: number }> = {};

  for (const r of receipts) {
    omzet += r.total_money || 0;
    for (const li of r.line_items || []) {
      laba += (li.total_money || 0) - (li.cost_total || 0);
      if (!itemMap[li.item_name]) itemMap[li.item_name] = { qty: 0, omzet: 0 };
      itemMap[li.item_name].qty += li.quantity || 0;
      itemMap[li.item_name].omzet += li.total_money || 0;
    }
  }

  const allItems: TopItem[] = Object.entries(itemMap)
    .sort((a, b) => b[1].qty - a[1].qty) as TopItem[];

  const jumlahTransaksi = receipts.length;
  const rataRata = jumlahTransaksi > 0 ? omzet / jumlahTransaksi : 0;

  return { omzet, laba, jumlahTransaksi, rataRata, allItems };
}

// === FORMAT RUPIAH =====================================
function formatRupiah(n: number) {
  return "Rp" + Math.round(n).toLocaleString("id-ID");
}

// === LAPORAN WHATSAPP ==================================
function formatLaporanToko(nama: string, s: ReturnType<typeof summarize>) {
  let text = `*${nama}*\n`;
  text += `Omzet: ${formatRupiah(s.omzet)}\n`;
  text += `Laba: ${formatRupiah(s.laba)}\n`;
  text += `Transaksi: ${s.jumlahTransaksi}x (rata-rata ${formatRupiah(s.rataRata)})\n`;
  if (s.allItems.length > 0) {
    text += `Item terlaris:\n`;
    s.allItems.slice(0, 5).forEach(([name, d], i) => {
      text += `${i+1}. ${name} - ${d.qty}x (${formatRupiah(d.omzet)})\n`;
    });
  }
  return text;
}

async function sendWhatsApp(env: Env, message: string) {
  const res = await fetch("https://api.fonnte.com/send", {
    method: "POST",
    headers: { Authorization: env.FONNTE_TOKEN, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ target: env.WA_NUMBER, message }),
  });
  console.log("Fonnte status:", res.status, "response:", await res.text());
}

// === INSIGHT AI ========================================
async function generateInsight(
  env: Env,
  label: string,
  periodeText: string,
  s1: ReturnType<typeof summarize>,
  s2: ReturnType<typeof summarize>,
  totalOmzet: number,
  totalLaba: number,
  totalTransaksi: number
): Promise<string> {
  const marginKasir1 = s1.omzet > 0 ? ((s1.laba / s1.omzet) * 100).toFixed(1) : "0";
  const marginKasir2 = s2.omzet > 0 ? ((s2.laba / s2.omzet) * 100).toFixed(1) : "0";
  const marginTotal = totalOmzet > 0 ? ((totalLaba / totalOmzet) * 100).toFixed(1) : "0";

  const dataText = `
Periode: ${periodeText} (${label})
Kasir 1: omzet Rp${Math.round(s1.omzet)}, laba Rp${Math.round(s1.laba)}, margin ${marginKasir1}%, ${s1.jumlahTransaksi} transaksi, rata-rata Rp${Math.round(s1.rataRata)}/transaksi
Kasir 2: omzet Rp${Math.round(s2.omzet)}, laba Rp${Math.round(s2.laba)}, margin ${marginKasir2}%, ${s2.jumlahTransaksi} transaksi, rata-rata Rp${Math.round(s2.rataRata)}/transaksi
Total gabungan: omzet Rp${Math.round(totalOmzet)}, laba Rp${Math.round(totalLaba)}, margin ${marginTotal}%, ${totalTransaksi} transaksi
Item terlaris kasir 1: ${s1.allItems.slice(0,3).map(([n,d]) => `${n} (${d.qty}x, Rp${Math.round(d.omzet)})`).join(", ") || "-"}
Item terlaris kasir 2: ${s2.allItems.slice(0,3).map(([n,d]) => `${n} (${d.qty}x, Rp${Math.round(d.omzet)})`).join(", ") || "-"}
`.trim();

  try {
    const response: any = await env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
      messages: [
        { role: "system", content: "Kamu adalah analis bisnis. Berikan insight singkat (maks 3 kalimat) berdasarkan data, fokus pada margin dan saran actionable. Sebutkan angka persen. Jangan basa-basi." },
        { role: "user", content: dataText }
      ]
    });
    return (response.response || "").trim();
  } catch { return ""; }
}

// === BUILD & SEND REPORT (CRON) =======================
async function buildAndSendReport(env: Env, label: string, fromDateStr: string, toDateStr: string, judul: string) {
  const { fromISO, toISO } = dateStrToISORangeWIB(fromDateStr, toDateStr);
  const periodeText = fromDateStr === toDateStr ? fromDateStr : `${fromDateStr} s/d ${toDateStr}`;

  const [receipts1, receipts2] = await Promise.all([
    fetchAllReceipts(env.LOYVERSE_API_TOKEN, fromISO, toISO),
    fetchAllReceipts(env.LOYVERSE_API_TOKEN_2, fromISO, toISO),
  ]);

  const s1 = summarize(receipts1);
  const s2 = summarize(receipts2);
  const totalOmzet = s1.omzet + s2.omzet;
  const totalLaba = s1.laba + s2.laba;
  const totalTransaksi = s1.jumlahTransaksi + s2.jumlahTransaksi;

  let laporan = `📊 *${judul} ${periodeText}*\n\n`;
  laporan += formatLaporanToko("Kasir 1", s1) + "\n";
  laporan += formatLaporanToko("Kasir 2", s2) + "\n";
  laporan += `*TOTAL GABUNGAN*\n`;
  laporan += `Omzet: ${formatRupiah(totalOmzet)}\nLaba: ${formatRupiah(totalLaba)}\nTotal transaksi: ${totalTransaksi}x`;

  const insight = await generateInsight(env, label, periodeText, s1, s2, totalOmzet, totalLaba, totalTransaksi);
  if (insight) laporan += `\n\n🤖 *Insight:*\n${insight}`;

  laporan += `\n\n🔗 *Dashboard:* https://mcp-google-oauth.akmalnurfauzii.workers.dev/panel-vitamart-view`;

  await sendWhatsApp(env, laporan);
}

async function sendDailyReport(env: Env) {
  const now = new Date();
  const wibNow = new Date(now.getTime() + 7 * 60 * 60 * 1000);
  const wibDayOfWeek = wibNow.getUTCDay();
  const wibDateOfMonth = wibNow.getUTCDate();
  const dateStr = getYesterdayDateStr();

  await buildAndSendReport(env, "harian", dateStr, dateStr, "Laporan Penjualan");

  if (wibDayOfWeek === 1) {
    const weekFrom = addDaysToDateStr(dateStr, -6);
    await buildAndSendReport(env, "mingguan", weekFrom, dateStr, "Laporan Mingguan");
  }
  if (wibDateOfMonth === 1) {
    const [year, month] = dateStr.split("-");
    await buildAndSendReport(env, "bulanan", `${year}-${month}-01`, dateStr, "Laporan Bulanan");
  }
}

// === DASHBOARD DATA ====================================
async function buildDashboardData(env: Env, fromDateStr: string, toDateStr: string) {
  const { fromISO, toISO } = dateStrToISORangeWIB(fromDateStr, toDateStr);
  const [receipts1, receipts2] = await Promise.all([
    fetchAllReceipts(env.LOYVERSE_API_TOKEN, fromISO, toISO),
    fetchAllReceipts(env.LOYVERSE_API_TOKEN_2, fromISO, toISO),
  ]);

  const dates: string[] = [];
  let current = new Date(`${fromDateStr}T00:00:00+07:00`);
  const end = new Date(`${toDateStr}T00:00:00+07:00`);
  while (current <= end) {
    dates.push(current.toISOString().split("T")[0]);
    current.setDate(current.getDate() + 1);
  }

  const omzet1: Record<string, number> = {}, omzet2: Record<string, number> = {};
  const laba1: Record<string, number> = {}, laba2: Record<string, number> = {};
  for (const d of dates) { omzet1[d]=0; omzet2[d]=0; laba1[d]=0; laba2[d]=0; }

  function bucket(receipts: Receipt[], omzetMap: Record<string,number>, labaMap: Record<string,number>) {
    for (const r of receipts) {
      const created = new Date(r.created_at);
      const wibDate = new Date(created.getTime() + 7*60*60*1000).toISOString().split("T")[0];
      if (!(wibDate in omzetMap)) continue;
      omzetMap[wibDate] += r.total_money || 0;
      for (const li of r.line_items || []) {
        labaMap[wibDate] += (li.total_money || 0) - (li.cost_total || 0);
      }
    }
  }
  bucket(receipts1, omzet1, laba1);
  bucket(receipts2, omzet2, laba2);

  const s1 = summarize(receipts1);
  const s2 = summarize(receipts2);

  const beyond31Days = isMoreThan31Days(fromDateStr, toDateStr);
  const isDataEmpty = s1.omzet === 0 && s2.omzet === 0;

  return {
    periode: `${fromDateStr} s/d ${toDateStr}`,
    days: dates.length,
    dates,
    omzet1: dates.map(d => Math.round(omzet1[d])),
    omzet2: dates.map(d => Math.round(omzet2[d])),
    laba1: dates.map(d => Math.round(laba1[d])),
    laba2: dates.map(d => Math.round(laba2[d])),
    totalOmzet1: Math.round(s1.omzet),
    totalOmzet2: Math.round(s2.omzet),
    totalLaba1: Math.round(s1.laba),
    totalLaba2: Math.round(s2.laba),
    totalTransaksi1: s1.jumlahTransaksi,
    totalTransaksi2: s2.jumlahTransaksi,
    allItems1: s1.allItems.map(([name, data]) => ({ name, qty: data.qty, omzet: Math.round(data.omzet) })),
    allItems2: s2.allItems.map(([name, data]) => ({ name, qty: data.qty, omzet: Math.round(data.omzet) })),
    debug: { receipts1: receipts1.length, receipts2: receipts2.length },
    beyond31Days,
    isDataEmpty,
    from: fromDateStr,
    to: toDateStr,
  };
}

// ================================================================
// === RENDER HTML DASHBOARD — VERSI MOBILE-FIRST + DARK MODE ===
// ================================================================
function renderDashboardHTML(data: Awaited<ReturnType<typeof buildDashboardData>>): string {
  const fmt = (n: number) => "Rp" + Math.round(n).toLocaleString("id-ID");
  const today = getTodayDateStr();
  const yesterday = getYesterdayDateStr();
  const monthAgo = addMonthsToDateStr(today, -1);
  const firstDayMonthAgo = getFirstDayOfMonth(monthAgo);
  const lastDayMonthAgo = getLastDayOfMonth(monthAgo);

  const showUpgradeMessage = data.beyond31Days && data.isDataEmpty;

  const activeClass = (condition: boolean) =>
    condition
      ? "bg-amber-400 text-black border-amber-400 shadow-lg shadow-amber-400/30"
      : "bg-white/10 text-white/70 border-white/10 hover:bg-white/20 dark:bg-gray-700/50 dark:text-gray-300 dark:hover:bg-gray-600";

  return `<!DOCTYPE html>
<html lang="id" class="dark">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.5" />
  <title>Dashboard Penjualan - Kedai Vitamart</title>
  <!-- Tailwind CSS via CDN -->
  <script src="https://cdn.tailwindcss.com"></script>
  <!-- FIX BUG: wajib set darkMode:'class' di sini, kalau tidak Tailwind CDN
       cuma ngikutin dark mode SISTEM OS, bukan class 'dark' yang di-toggle
       manual lewat JS -- ini penyebab toggle theme sebelumnya gak jalan -->
  <script>
    tailwind.config = {
      darkMode: 'class'
    }
  </script>
  <!-- Chart.js -->
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js"></script>
  <style>
    * { transition: background-color 0.2s ease, border-color 0.2s ease, color 0.2s ease; }
    body { font-family: 'Segoe UI', system-ui, -apple-system, sans-serif; }
    .chart-container { position: relative; height: 200px; width: 100%; }
    .table-scroll { max-height: 300px; overflow-y: auto; }
    .table-scroll::-webkit-scrollbar { width: 6px; }
    .table-scroll::-webkit-scrollbar-track { background: #1e293b; border-radius: 8px; }
    .table-scroll::-webkit-scrollbar-thumb { background: #475569; border-radius: 8px; }
    .dark .table-scroll::-webkit-scrollbar-track { background: #1e293b; }
    .dark .table-scroll::-webkit-scrollbar-thumb { background: #475569; }
  </style>
</head>
<body class="bg-gray-100 dark:bg-slate-900 text-gray-900 dark:text-gray-100 min-h-screen p-4 md:p-6 transition-colors">

  <div class="max-w-7xl mx-auto">

    <div class="bg-white dark:bg-slate-800 rounded-2xl shadow-lg p-5 md:p-6 mb-6 border border-gray-200 dark:border-slate-700 flex flex-wrap items-center justify-between">
      <div>
        <h1 class="text-xl md:text-2xl font-bold flex items-center gap-2">
          <span>📊</span> Dashboard Penjualan
        </h1>
        <p class="text-sm text-gray-500 dark:text-gray-400 mt-1">
          Periode: ${data.periode} (${data.days} hari) • Total Omzet: ${fmt(data.totalOmzet1 + data.totalOmzet2)}
        </p>
      </div>
      <div class="flex items-center gap-2 mt-2 md:mt-0">
        <span class="inline-flex items-center gap-1 text-xs bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300 px-3 py-1 rounded-full border border-green-200 dark:border-green-800">
          <span class="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse"></span> Live
        </span>
        <button id="themeToggle" class="p-2 rounded-full bg-gray-200 dark:bg-slate-700 hover:bg-gray-300 dark:hover:bg-slate-600 transition" aria-label="Toggle tema">
          <span id="themeIcon" class="text-xl">🌙</span>
        </button>
      </div>
    </div>

    ${showUpgradeMessage ? `
    <div class="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700/50 rounded-xl p-4 mb-6 flex flex-wrap items-center gap-3">
      <span class="text-2xl">🔒</span>
      <p class="flex-1 text-sm text-amber-800 dark:text-amber-200">
        <strong>Data di luar 31 hari terakhir tidak tersedia</strong> — Loyverse Free Plan hanya menyimpan 31 hari terakhir.
        <br class="sm:hidden" /> Aktifkan <strong>Unlimited Sales History</strong> add-on untuk akses semua data historis.
      </p>
      <a href="https://loyverse.com/pricing" target="_blank" class="bg-amber-500 hover:bg-amber-600 text-black font-semibold px-4 py-2 rounded-lg text-sm transition">
        💎 Upgrade Sekarang
      </a>
    </div>
    ` : ''}

    <form class="bg-white dark:bg-slate-800 rounded-xl shadow-lg p-4 md:p-5 mb-6 border border-gray-200 dark:border-slate-700" method="GET" action="" id="filterForm">
      <div class="flex flex-wrap items-center gap-2 md:gap-3">
        <label class="text-sm font-medium text-gray-600 dark:text-gray-300">📅 Dari</label>
        <input type="date" name="from" value="${data.from}" id="fromDate" required
               class="bg-gray-100 dark:bg-slate-700 border border-gray-300 dark:border-slate-600 rounded-lg px-3 py-1.5 text-sm text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-amber-400 outline-none" />

        <label class="text-sm font-medium text-gray-600 dark:text-gray-300">Sampai</label>
        <input type="date" name="to" value="${data.to}" id="toDate" required
               class="bg-gray-100 dark:bg-slate-700 border border-gray-300 dark:border-slate-600 rounded-lg px-3 py-1.5 text-sm text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-amber-400 outline-none" />

        <button type="submit" class="bg-amber-500 hover:bg-amber-600 text-black font-semibold px-4 py-1.5 rounded-lg text-sm transition">
          Tampilkan
        </button>

        <div class="flex flex-wrap items-center gap-1.5 mt-1 sm:mt-0">
          <a href="?from=${today}&to=${today}" class="px-3 py-1 rounded-lg text-xs font-medium border transition ${activeClass(data.from === today && data.to === today)}">Hari Ini</a>
          <a href="?from=${yesterday}&to=${yesterday}" class="px-3 py-1 rounded-lg text-xs font-medium border transition ${activeClass(data.from === yesterday && data.to === yesterday)}">Kemarin</a>
          <a href="?from=${addDaysToDateStr(today, -6)}&to=${today}" class="px-3 py-1 rounded-lg text-xs font-medium border transition ${activeClass(data.from === addDaysToDateStr(today, -6) && data.to === today)}">7 Hari</a>
          <a href="?from=${addDaysToDateStr(today, -29)}&to=${today}" class="px-3 py-1 rounded-lg text-xs font-medium border transition ${activeClass(data.from === addDaysToDateStr(today, -29) && data.to === today)}">30 Hari</a>
          <a href="?from=${addDaysToDateStr(today, -89)}&to=${today}" class="px-3 py-1 rounded-lg text-xs font-medium border transition ${activeClass(data.from === addDaysToDateStr(today, -89) && data.to === today)}">90 Hari</a>
          <a href="?from=${firstDayMonthAgo}&to=${lastDayMonthAgo}" class="px-3 py-1 rounded-lg text-xs font-medium border transition ${activeClass(data.from === firstDayMonthAgo && data.to === lastDayMonthAgo)}">Bulan Lalu</a>
          <button type="button" onclick="navigateMonth(-1)" class="px-3 py-1 rounded-lg text-xs font-medium border border-white/10 dark:border-slate-600 hover:bg-white/20 dark:hover:bg-slate-600 transition">◀</button>
          <button type="button" onclick="navigateMonth(1)" class="px-3 py-1 rounded-lg text-xs font-medium border border-white/10 dark:border-slate-600 hover:bg-white/20 dark:hover:bg-slate-600 transition">▶</button>
        </div>
      </div>
    </form>

    <div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 md:gap-4 mb-6">
      <div class="bg-white dark:bg-slate-800 rounded-xl shadow p-4 border border-gray-200 dark:border-slate-700">
        <p class="text-xs text-gray-500 dark:text-gray-400">💰 Omzet Kasir 1</p>
        <p class="text-lg font-bold text-blue-600 dark:text-blue-400">${fmt(data.totalOmzet1)}</p>
      </div>
      <div class="bg-white dark:bg-slate-800 rounded-xl shadow p-4 border border-gray-200 dark:border-slate-700">
        <p class="text-xs text-gray-500 dark:text-gray-400">💰 Omzet Kasir 2</p>
        <p class="text-lg font-bold text-emerald-600 dark:text-emerald-400">${fmt(data.totalOmzet2)}</p>
      </div>
      <div class="bg-white dark:bg-slate-800 rounded-xl shadow p-4 border border-gray-200 dark:border-slate-700">
        <p class="text-xs text-gray-500 dark:text-gray-400">📈 Laba Kasir 1</p>
        <p class="text-lg font-bold text-pink-600 dark:text-pink-400">${fmt(data.totalLaba1)}</p>
      </div>
      <div class="bg-white dark:bg-slate-800 rounded-xl shadow p-4 border border-gray-200 dark:border-slate-700">
        <p class="text-xs text-gray-500 dark:text-gray-400">📈 Laba Kasir 2</p>
        <p class="text-lg font-bold text-amber-600 dark:text-amber-400">${fmt(data.totalLaba2)}</p>
      </div>
      <div class="bg-white dark:bg-slate-800 rounded-xl shadow p-4 border border-gray-200 dark:border-slate-700">
        <p class="text-xs text-gray-500 dark:text-gray-400">🧾 Transaksi Kasir 1</p>
        <p class="text-lg font-bold text-purple-600 dark:text-purple-400">${data.totalTransaksi1}x</p>
      </div>
      <div class="bg-white dark:bg-slate-800 rounded-xl shadow p-4 border border-gray-200 dark:border-slate-700">
        <p class="text-xs text-gray-500 dark:text-gray-400">🧾 Transaksi Kasir 2</p>
        <p class="text-lg font-bold text-orange-600 dark:text-orange-400">${data.totalTransaksi2}x</p>
      </div>
    </div>

    <div class="bg-white dark:bg-slate-800 rounded-xl shadow p-4 md:p-6 mb-6 border border-gray-200 dark:border-slate-700">
      <h2 class="text-base font-semibold mb-3">📈 Tren Omzet Harian</h2>
      <div class="chart-container">
        <canvas id="trendChart"></canvas>
      </div>
    </div>

    <div class="bg-white dark:bg-slate-800 rounded-xl shadow p-4 md:p-6 mb-6 border border-gray-200 dark:border-slate-700">
      <h2 class="text-base font-semibold mb-3">📊 Perbandingan Kasir</h2>
      <div class="chart-container" style="height:180px;">
        <canvas id="compareChart"></canvas>
      </div>
    </div>

    <div class="grid grid-cols-1 md:grid-cols-2 gap-4 md:gap-6 mb-6">
      <div class="bg-white dark:bg-slate-800 rounded-xl shadow p-4 md:p-6 border border-gray-200 dark:border-slate-700">
        <h2 class="text-base font-semibold mb-3">📦 Semua Item Terjual - Kasir 1</h2>
        ${data.allItems1.length ? `
        <div class="table-scroll">
          <table class="w-full text-sm">
            <thead class="text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-slate-700">
              <tr><th class="text-left py-2">Item</th><th class="text-left py-2">Qty</th><th class="text-left py-2">Omzet</th></tr>
            </thead>
            <tbody>
              ${data.allItems1.map(it => `<tr class="border-b border-gray-100 dark:border-slate-700/50"><td class="py-2">${it.name}</td><td class="py-2">${it.qty}x</td><td class="py-2">${fmt(it.omzet)}</td></tr>`).join("")}
            </tbody>
          </table>
        </div>
        ` : `<p class="text-gray-400 text-sm py-4 text-center">${showUpgradeMessage ? '🔒 Upgrade untuk lihat data historis' : 'Tidak ada data'}</p>`}
      </div>

      <div class="bg-white dark:bg-slate-800 rounded-xl shadow p-4 md:p-6 border border-gray-200 dark:border-slate-700">
        <h2 class="text-base font-semibold mb-3">📦 Semua Item Terjual - Kasir 2</h2>
        ${data.allItems2.length ? `
        <div class="table-scroll">
          <table class="w-full text-sm">
            <thead class="text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-slate-700">
              <tr><th class="text-left py-2">Item</th><th class="text-left py-2">Qty</th><th class="text-left py-2">Omzet</th></tr>
            </thead>
            <tbody>
              ${data.allItems2.map(it => `<tr class="border-b border-gray-100 dark:border-slate-700/50"><td class="py-2">${it.name}</td><td class="py-2">${it.qty}x</td><td class="py-2">${fmt(it.omzet)}</td></tr>`).join("")}
            </tbody>
          </table>
        </div>
        ` : `<p class="text-gray-400 text-sm py-4 text-center">${showUpgradeMessage ? '🔒 Upgrade untuk lihat data historis' : 'Tidak ada data'}</p>`}
      </div>
    </div>

    <div class="text-center text-xs text-gray-400 dark:text-gray-500 border-t border-gray-200 dark:border-slate-700 pt-4 mt-4">
      Data real-time dari Loyverse • ${new Date().toLocaleString('id-ID')}
      <div class="mt-1">📊 Receipt diambil: Kasir1=${data.debug.receipts1}, Kasir2=${data.debug.receipts2}</div>
    </div>

  </div>

  <script>
    function navigateMonth(delta) {
      const fromInput = document.getElementById('fromDate');
      const toInput = document.getElementById('toDate');
      let from = new Date(fromInput.value + 'T00:00:00+07:00');
      let to = new Date(toInput.value + 'T00:00:00+07:00');
      from.setMonth(from.getMonth() + delta);
      to.setMonth(to.getMonth() + delta);
      fromInput.value = from.toISOString().split('T')[0];
      toInput.value = to.toISOString().split('T')[0];
      document.getElementById('filterForm').submit();
    }

    (function() {
      const html = document.documentElement;
      const toggleBtn = document.getElementById('themeToggle');
      const icon = document.getElementById('themeIcon');

      let isDark = localStorage.getItem('theme') === 'dark' ||
                   (!localStorage.getItem('theme') && window.matchMedia('(prefers-color-scheme: dark)').matches);

      function applyTheme(dark) {
        if (dark) {
          html.classList.add('dark');
          icon.textContent = '☀️';
        } else {
          html.classList.remove('dark');
          icon.textContent = '🌙';
        }
        localStorage.setItem('theme', dark ? 'dark' : 'light');
        isDark = dark;
      }

      applyTheme(isDark);

      toggleBtn.addEventListener('click', function() {
        applyTheme(!isDark);
      });
    })();

    const dates = ${JSON.stringify(data.dates)};
    const omzet1 = ${JSON.stringify(data.omzet1)};
    const omzet2 = ${JSON.stringify(data.omzet2)};

    new Chart(document.getElementById('trendChart'), {
      type: 'line',
      data: {
        labels: dates,
        datasets: [
          { label: 'Kasir 1', data: omzet1, borderColor: '#3b82f6', backgroundColor: 'rgba(59,130,246,0.1)', fill: true, tension: 0.3 },
          { label: 'Kasir 2', data: omzet2, borderColor: '#10b981', backgroundColor: 'rgba(16,185,129,0.1)', fill: true, tension: 0.3 }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 800, easing: 'easeInOutQuart' },
        plugins: {
          legend: { labels: { color: document.documentElement.classList.contains('dark') ? '#cbd5e1' : '#1e293b' } }
        },
        scales: {
          x: { ticks: { color: document.documentElement.classList.contains('dark') ? '#94a3b8' : '#64748b', maxRotation: 30, autoSkip: true, maxTicksLimit: 20 } },
          y: { ticks: { color: document.documentElement.classList.contains('dark') ? '#94a3b8' : '#64748b', callback: v => 'Rp' + Number(v).toLocaleString('id-ID') } }
        }
      }
    });

    new Chart(document.getElementById('compareChart'), {
      type: 'bar',
      data: {
        labels: ['Omzet', 'Laba'],
        datasets: [
          { label: 'Kasir 1', data: [${data.totalOmzet1}, ${data.totalLaba1}], backgroundColor: '#3b82f6' },
          { label: 'Kasir 2', data: [${data.totalOmzet2}, ${data.totalLaba2}], backgroundColor: '#10b981' }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 800, easing: 'easeInOutQuart' },
        plugins: {
          legend: { labels: { color: document.documentElement.classList.contains('dark') ? '#cbd5e1' : '#1e293b' } }
        },
        scales: {
          x: { ticks: { color: document.documentElement.classList.contains('dark') ? '#94a3b8' : '#64748b' } },
          y: { ticks: { color: document.documentElement.classList.contains('dark') ? '#94a3b8' : '#64748b', callback: v => 'Rp' + Number(v).toLocaleString('id-ID') } }
        }
      }
    });
  </script>
</body>
</html>`;
}

// === OAUTH PROVIDER =====================================
const oauthProvider = new OAuthProvider({
  apiRoute: "/mcp",
  apiHandler: MyMCP.serve("/mcp") as any,
  defaultHandler: GoogleHandler as any,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
});

// === WORKER EXPORT ======================================
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    if (url.pathname === "/debug/test-report") {
      if (url.searchParams.get("secret") !== env.FONNTE_TOKEN) return new Response("Unauthorized", { status: 401 });
      const type = url.searchParams.get("type") || "harian";
      const dateStr = getYesterdayDateStr();
      if (type === "mingguan") {
        const weekFrom = addDaysToDateStr(dateStr, -6);
        await buildAndSendReport(env, "mingguan", weekFrom, dateStr, "Laporan Mingguan");
      } else if (type === "bulanan") {
        const [year, month] = dateStr.split("-");
        await buildAndSendReport(env, "bulanan", `${year}-${month}-01`, dateStr, "Laporan Bulanan");
      } else {
        await buildAndSendReport(env, "harian", dateStr, dateStr, "Laporan Penjualan");
      }
      return new Response(`Test report (${type}) terkirim.`);
    }

    if (url.pathname === "/panel-vitamart-view") {
      const today = getTodayDateStr();
      let from = url.searchParams.get("from") || addDaysToDateStr(today, -6);
      let to = url.searchParams.get("to") || today;
      if (from > to) [from, to] = [to, from];

      const data = await buildDashboardData(env, from, to);
      const html = renderDashboardHTML(data);
      return new Response(html, { headers: { "Content-Type": "text/html;charset=UTF-8" } });
    }

    return oauthProvider.fetch(request, env, ctx);
  },
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(sendDailyReport(env));
  }
};