import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";
import { GoogleHandler } from "./google-handler";

// === TIPE ==============================================
type Props = { name: string; email: string; accessToken: string };
// [FIX] Tambah receipt_type + variant_name dari API Loyverse
type Receipt = {
  receipt_number?: string;
  total_money: number;
  receipt_type?: string;
  refund_for?: string | null;
  created_at: string;
  line_items: {
    item_name: string;
    variant_name?: string;
    quantity: number;
    total_money: number;
    cost_total: number;
  }[];
};
type TopItem = [string, { qty: number; omzet: number }];
type VariantChild = { label: string; qty: number; omzet: number };
type ParentItem = { name: string; qty: number; omzet: number; variants: VariantChild[] };
// [BARU] Satu baris riwayat refund untuk ditampilkan di dashboard
type RefundLogEntry = {
  receiptNumber: string;
  refundFor: string | null;
  itemName: string;
  variantName: string;
  quantity: number;
  money: number;
  time: string; // jam WIB, format HH:mm
};

// Fallback label kalau variant_name kosong di API (jarang terjadi, tapi jaga-jaga)
const VARIANT_PRICE_LABELS: Record<number, string> = {
  6000: "Cup Besar",
  5000: "Normal",
};

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

// [FIX BUG LAMA] Sebelumnya fungsi-fungsi di bawah ini pakai d.getDate()/
// d.setDate() (method LOKAL, tergantung timezone runtime) padahal dipanggil
// dengan offset +07:00 -- kalau runtime-nya bukan +07:00 (Cloudflare Workers
// selalu UTC), hasilnya bisa geser 1 hari/bulan. Fix: parse sebagai UTC murni
// (tanpa offset, karena ini aritmatika tanggal kalender, bukan konversi jam
// nyata) dan pakai method getUTC*/setUTC* supaya hasilnya sama persis di
// runtime manapun.
function addDaysToDateStr(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().split("T")[0];
}

function addMonthsToDateStr(dateStr: string, months: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + months);
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
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(1);
  return d.toISOString().split("T")[0];
}

function getLastDayOfMonth(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + 1);
  d.setUTCDate(0);
  return d.toISOString().split("T")[0];
}

function isMoreThan31Days(fromDateStr: string, toDateStr: string): boolean {
  const from = new Date(`${fromDateStr}T00:00:00+07:00`);
  const to = new Date(`${toDateStr}T00:00:00+07:00`);
  const diffTime = Math.abs(to.getTime() - from.getTime());
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  return diffDays > 31;
}

// [BARU] Hitung tanggal periode SEBELUMNYA dengan panjang yang sama persis,
// supaya perbandingan apple-to-apple. Contoh: kalau periode dipilih 7 hari
// (5-11 Sept), periode sebelumnya juga 7 hari (28 Agu-3 Sept) -- bukan cuma
// mundur 1 hari, supaya panjang periode konsisten.
function getPreviousPeriod(fromDateStr: string, toDateStr: string): { prevFrom: string; prevTo: string } {
  const from = new Date(`${fromDateStr}T00:00:00+07:00`);
  const to = new Date(`${toDateStr}T00:00:00+07:00`);
  const diffDays = Math.round((to.getTime() - from.getTime()) / (1000 * 60 * 60 * 24)) + 1; // jumlah hari inklusif
  const prevTo = addDaysToDateStr(fromDateStr, -1);
  const prevFrom = addDaysToDateStr(prevTo, -(diffDays - 1));
  return { prevFrom, prevTo };
}

// [BARU] Hitung persentase perubahan dengan aman -- hindari divide-by-zero.
// Kalau nilai sebelumnya 0 dan sekarang > 0, dianggap "baru" (null artinya
// tidak ada dasar perbandingan, bukan 0% atau infinity%).
function calcPercentChange(current: number, previous: number): number | null {
  if (previous === 0) {
    return current === 0 ? 0 : null; // null = "Baru", tidak ada basis pembanding
  }
  return ((current - previous) / previous) * 100;
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

// === SUMMARIZE (UNTUK KASIR 1 -- GABUNG SEMUA, POLOS) ===
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

// === BUILD ITEM BERTINGKAT (UNTUK KASIR 2 -- parent + breakdown varian)
// [FIX UTAMA] Grouping varian sekarang pakai `variant_name` sebagai KEY,
// bukan `unitPrice`. Sebelumnya, dua baris "Cupbesar" dengan total_money
// yang beda (karena promo/pembulatan/refund parsial) dianggap dua varian
// BERBEDA karena unitPrice-nya beda -> pecah jadi 2 baris terpisah, dan
// kalau salah satu ke-filter (misal net qty jadi 0), yang lain kelihatan
// seolah cuma "1x" padahal totalnya harusnya 2x.
// Sekarang: kalau variant_name ada, itu yang dipakai sebagai key -> semua
// "Cupbesar" digabung jadi satu baris apa pun harganya.
// Refund (receipt_type === "REFUND") dikurangi (sign = -1), termasuk di
// level varian, supaya breakdown varian konsisten dengan total omzet.
function buildKasir2Items(receipts: Receipt[]) {
  let omzet = 0, laba = 0;
  const itemMap: Record<
    string,
    { qty: number; omzet: number; variantMap: Record<string, { qty: number; omzet: number }> }
  > = {};

  for (const r of receipts) {
    const isRefund = (r.receipt_type || "").toUpperCase() === "REFUND";
    const sign = isRefund ? -1 : 1;

    omzet += sign * (r.total_money || 0);
    for (const li of r.line_items || []) {
      laba += sign * ((li.total_money || 0) - (li.cost_total || 0));
      const name = li.item_name;
      if (!itemMap[name]) itemMap[name] = { qty: 0, omzet: 0, variantMap: {} };
      itemMap[name].qty += sign * (li.quantity || 0);
      itemMap[name].omzet += sign * (li.total_money || 0);

      // Key varian: pakai variant_name kalau tersedia (paling akurat, ikut
      // data resmi Loyverse). Kalau kosong, fallback ke harga per unit
      // sebagai proxy -- bukan sebaliknya.
      const unitPrice = li.quantity > 0 ? Math.round((li.total_money || 0) / li.quantity) : 0;
      const variantKey =
        li.variant_name && li.variant_name.trim() !== ""
          ? li.variant_name.trim()
          : (VARIANT_PRICE_LABELS[unitPrice] || `${formatRupiah(unitPrice)}/pcs`);

      if (!itemMap[name].variantMap[variantKey]) {
        itemMap[name].variantMap[variantKey] = { qty: 0, omzet: 0 };
      }
      itemMap[name].variantMap[variantKey].qty += sign * (li.quantity || 0);
      itemMap[name].variantMap[variantKey].omzet += sign * (li.total_money || 0);
    }
  }

  const allItems: ParentItem[] = Object.entries(itemMap)
    .map(([name, d]) => {
      // qty !== 0 (bukan > 0) supaya varian net-zero (sale ke-refund penuh)
      // tetap kebaca sebagai 0x, bukan hilang diam-diam dari data.
      const variantEntries = Object.entries(d.variantMap).filter(([_, v]) => v.qty !== 0);
      const variants: VariantChild[] =
        variantEntries.length > 1
          ? variantEntries
              .map(([label, v]) => ({ label, qty: v.qty, omzet: v.omzet }))
              .sort((a, b) => b.qty - a.qty)
          : [];
      return { name, qty: d.qty, omzet: d.omzet, variants };
    })
    .sort((a, b) => b.qty - a.qty);

  const jumlahTransaksi = receipts.length;
  const rataRata = jumlahTransaksi > 0 ? omzet / jumlahTransaksi : 0;

  return { omzet, laba, jumlahTransaksi, rataRata, allItems };
}

// === TOTAL GABUNGAN VARIAN NORMAL vs CUP BESAR (BARU) ===
// Item yang dikecualikan dari agregasi ini -- dihitung sendiri-sendiri
// sebagai produk mandiri, TIDAK ikut digabung ke total Normal/Cup Besar,
// karena sifatnya beda (bukan varian ukuran cup yang sama dengan menu lain).
// Cocokkan case-insensitive & trim supaya tidak sensitif kapitalisasi.
const EXCLUDED_FROM_VARIANT_TOTAL = [
  "es teh",
  "es batu",
  "pink lava",
  "green lava",
  "es kelapa muda",
  "kelapa 1 butir",
];

// [FIX] Baca LANGSUNG dari raw receipts (bukan dari allItems/ParentItem yang
// sudah diproses buildKasir2Items), karena breakdown varian di sana CUMA
// muncul kalau item punya >1 varian berbeda -- item yang cuma pernah dijual
// dalam SATU varian (misal "Thai tea" selalu "Normal") tampil flat tanpa
// breakdown, dan qty-nya jadi kelewat kalau cuma baca dari situ.
// Juga: label gabungan seperti "Normal / Normal" atau "Cupbesar / Cupbesar"
// (item dengan 2 modifier ukuran) dicocokkan berdasarkan KEBERADAAN kata
// "normal"/"cupbesar" di labelnya (substring match), bukan exact match --
// supaya tetap terhitung sesuai jenisnya, bukan diabaikan total.
function buildVariantTotals(receipts: Receipt[]): {
  normal: { qty: number; omzet: number };
  cupbesar: { qty: number; omzet: number };
  excludedNames: string[];
} {
  let normalQty = 0, normalOmzet = 0, cupQty = 0, cupOmzet = 0;

  for (const r of receipts) {
    const isRefund = (r.receipt_type || "").toUpperCase() === "REFUND";
    const sign = isRefund ? -1 : 1;

    for (const li of r.line_items || []) {
      const nameLower = (li.item_name || "").trim().toLowerCase();
      if (EXCLUDED_FROM_VARIANT_TOTAL.includes(nameLower)) continue;

      const unitPrice = li.quantity > 0 ? Math.round((li.total_money || 0) / li.quantity) : 0;
      const variantLabel =
        li.variant_name && li.variant_name.trim() !== ""
          ? li.variant_name.trim()
          : (VARIANT_PRICE_LABELS[unitPrice] || `${formatRupiah(unitPrice)}/pcs`);
      const labelLower = variantLabel.toLowerCase();

      if (labelLower.includes("cupbesar") || labelLower.includes("cup besar")) {
        cupQty += sign * (li.quantity || 0);
        cupOmzet += sign * (li.total_money || 0);
      } else if (labelLower.includes("normal")) {
        normalQty += sign * (li.quantity || 0);
        normalOmzet += sign * (li.total_money || 0);
      }
    }
  }

  return {
    normal: { qty: normalQty, omzet: normalOmzet },
    cupbesar: { qty: cupQty, omzet: cupOmzet },
    excludedNames: EXCLUDED_FROM_VARIANT_TOTAL,
  };
}
// supaya bisa ditampilkan di dashboard untuk audit -- tanpa perlu buka
// raw API manual tiap kali curiga ada refund janggal.
function extractRefundLog(receipts: Receipt[]): RefundLogEntry[] {
  const log: RefundLogEntry[] = [];

  for (const r of receipts) {
    if ((r.receipt_type || "").toUpperCase() !== "REFUND") continue;

    const created = new Date(r.created_at);
    const wib = new Date(created.getTime() + 7 * 60 * 60 * 1000);
    const hh = String(wib.getUTCHours()).padStart(2, "0");
    const mm = String(wib.getUTCMinutes()).padStart(2, "0");

    for (const li of r.line_items || []) {
      log.push({
        receiptNumber: r.receipt_number || "-",
        refundFor: r.refund_for || null,
        itemName: li.item_name,
        variantName: li.variant_name && li.variant_name.trim() !== "" ? li.variant_name.trim() : "-",
        quantity: li.quantity || 0,
        money: li.total_money || 0,
        time: `${hh}:${mm}`,
      });
    }
  }

  // Urutkan dari yang paling baru
  return log.sort((a, b) => (a.time < b.time ? 1 : -1));
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
      text += `${i + 1}. ${name} - ${d.qty}x (${formatRupiah(d.omzet)})\n`;
    });
  }
  return text;
}

function formatLaporanKasir2(s: ReturnType<typeof buildKasir2Items>) {
  let text = `*Kasir 2*\n`;
  text += `Omzet: ${formatRupiah(s.omzet)}\n`;
  text += `Laba: ${formatRupiah(s.laba)}\n`;
  text += `Transaksi: ${s.jumlahTransaksi}x (rata-rata ${formatRupiah(s.rataRata)})\n`;
  if (s.allItems.length > 0) {
    text += `Item terlaris:\n`;
    s.allItems.slice(0, 5).forEach((it, i) => {
      text += `${i + 1}. ${it.name} - ${it.qty}x (${formatRupiah(it.omzet)})\n`;
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
  s2: ReturnType<typeof buildKasir2Items>,
  totalOmzet: number,
  totalLaba: number,
  totalTransaksi: number
): Promise<string> {
  const marginKasir1 = s1.omzet > 0 ? ((s1.laba / s1.omzet) * 100).toFixed(1) : "0";
  const marginKasir2 = s2.omzet > 0 ? ((s2.laba / s2.omzet) * 100).toFixed(1) : "0";
  const marginTotal = totalOmzet > 0 ? ((totalLaba / totalOmzet) * 100).toFixed(1) : "0";

  const topKasir2 = s2.allItems
    .slice(0, 3)
    .map((it) => `${it.name} (${it.qty}x, ${formatRupiah(it.omzet)})`)
    .join(", ");

  const dataText = `
Periode: ${periodeText} (${label})
Kasir 1: omzet Rp${Math.round(s1.omzet)}, laba Rp${Math.round(s1.laba)}, margin ${marginKasir1}%, ${s1.jumlahTransaksi} transaksi, rata-rata Rp${Math.round(s1.rataRata)}/transaksi
Kasir 2: omzet Rp${Math.round(s2.omzet)}, laba Rp${Math.round(s2.laba)}, margin ${marginKasir2}%, ${s2.jumlahTransaksi} transaksi, rata-rata Rp${Math.round(s2.rataRata)}/transaksi
Total gabungan: omzet Rp${Math.round(totalOmzet)}, laba Rp${Math.round(totalLaba)}, margin ${marginTotal}%, ${totalTransaksi} transaksi
Item terlaris kasir 1: ${s1.allItems.slice(0, 3).map(([n, d]) => `${n} (${d.qty}x, Rp${Math.round(d.omzet)})`).join(", ") || "-"}
Item terlaris kasir 2: ${topKasir2 || "-"}
`.trim();

  try {
    const response: any = await env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
      messages: [
        {
          role: "system",
          content:
            "Kamu adalah analis bisnis. Berikan insight singkat (maks 3 kalimat) berdasarkan data, fokus pada margin dan saran actionable. Sebutkan angka persen. Jangan basa-basi.",
        },
        { role: "user", content: dataText },
      ],
    });
    return (response.response || "").trim();
  } catch {
    return "";
  }
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
  const s2 = buildKasir2Items(receipts2);
  const totalOmzet = s1.omzet + s2.omzet;
  const totalLaba = s1.laba + s2.laba;
  const totalTransaksi = s1.jumlahTransaksi + s2.jumlahTransaksi;

  let laporan = `📊 *${judul} ${periodeText}*\n\n`;
  laporan += formatLaporanToko("Kasir 1", s1) + "\n";
  laporan += formatLaporanKasir2(s2) + "\n";
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
  const { prevFrom, prevTo } = getPreviousPeriod(fromDateStr, toDateStr);
  const { fromISO: prevFromISO, toISO: prevToISO } = dateStrToISORangeWIB(prevFrom, prevTo);

  // Fetch periode sekarang DAN periode sebelumnya sekaligus (paralel),
  // supaya nggak nambah waktu loading dua kali lipat.
  const [receipts1, receipts2, prevReceipts1, prevReceipts2] = await Promise.all([
    fetchAllReceipts(env.LOYVERSE_API_TOKEN, fromISO, toISO),
    fetchAllReceipts(env.LOYVERSE_API_TOKEN_2, fromISO, toISO),
    fetchAllReceipts(env.LOYVERSE_API_TOKEN, prevFromISO, prevToISO),
    fetchAllReceipts(env.LOYVERSE_API_TOKEN_2, prevFromISO, prevToISO),
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
  for (const d of dates) { omzet1[d] = 0; omzet2[d] = 0; laba1[d] = 0; laba2[d] = 0; }

  // Kasir 2 handle refund; Kasir 1 tetap seperti semula (tidak ada laporan
  // refund yang diketahui di kasir 1 -- kalau ke depan ada, tinggal ganti
  // parameter terakhir jadi true juga).
  function bucket(
    receipts: Receipt[],
    omzetMap: Record<string, number>,
    labaMap: Record<string, number>,
    handleRefund: boolean = false
  ) {
    for (const r of receipts) {
      const created = new Date(r.created_at);
      const wibDate = new Date(created.getTime() + 7 * 60 * 60 * 1000).toISOString().split("T")[0];
      if (!(wibDate in omzetMap)) continue;
      const isRefund = handleRefund && (r.receipt_type || "").toUpperCase() === "REFUND";
      const sign = isRefund ? -1 : 1;
      omzetMap[wibDate] += sign * Math.abs(r.total_money || 0);
      for (const li of r.line_items || []) {
        labaMap[wibDate] += sign * ((li.total_money || 0) - (li.cost_total || 0));
      }
    }
  }
  bucket(receipts1, omzet1, laba1, false); // Kasir 1: default (tidak handle refund)
  bucket(receipts2, omzet2, laba2, true);  // Kasir 2: handle refund

  // [BARU] Agregasi per JAM (00:00-23:00), digabung lintas-tanggal kalau
  // rangenya lebih dari 1 hari -- supaya kelihatan pola jam ramai/sepi,
  // sama seperti laporan bawaan Loyverse. Granularitas ini beda dari
  // "Tren Omzet Harian" di atas (yang per-tanggal), jadi disimpan
  // terpisah, bukan menggantikan.
  function bucketByHour(receipts: Receipt[], handleRefund: boolean = false): number[] {
    const hourly = new Array(24).fill(0);
    for (const r of receipts) {
      const created = new Date(r.created_at);
      const wib = new Date(created.getTime() + 7 * 60 * 60 * 1000);
      const hour = wib.getUTCHours();
      const isRefund = handleRefund && (r.receipt_type || "").toUpperCase() === "REFUND";
      const sign = isRefund ? -1 : 1;
      hourly[hour] += sign * Math.abs(r.total_money || 0);
    }
    return hourly.map((v) => Math.round(v));
  }
  const hourly1 = bucketByHour(receipts1, false);
  const hourly2 = bucketByHour(receipts2, true);

  const s1 = summarize(receipts1);
  const s2 = buildKasir2Items(receipts2);

  // [BARU] Summary periode sebelumnya, untuk hitung persentase perubahan.
  // Kasir 1 pakai summarize() biasa (belum handle refund, konsisten
  // dengan cara Kasir 1 dihitung di tempat lain). Kasir 2 pakai
  // buildKasir2Items() yang sudah handle refund.
  const prevS1 = summarize(prevReceipts1);
  const prevS2 = buildKasir2Items(prevReceipts2);
  const totalOmzetPrev = prevS1.omzet + prevS2.omzet;
  const totalLabaPrev = prevS1.laba + prevS2.laba;
  const totalTransaksiPrev = prevS1.jumlahTransaksi + prevS2.jumlahTransaksi;

  // [BARU] Riwayat refund khusus Kasir 2 (Kasir 1 belum handle refund)
  const refundLog2 = extractRefundLog(receipts2);

  // [BARU] Total gabungan varian Normal vs Cup Besar lintas semua item
  // Kasir 2 (kecuali item yang dikecualikan di EXCLUDED_FROM_VARIANT_TOTAL)
  // -- baca langsung dari receipts2 (raw), bukan dari s2.allItems, supaya
  // item dengan hanya 1 jenis varian (flat, tanpa breakdown) tetap kehitung.
  const variantTotals2 = buildVariantTotals(receipts2);

  const beyond31Days = isMoreThan31Days(fromDateStr, toDateStr);
  const isDataEmpty = s1.omzet === 0 && s2.omzet === 0;

  return {
    periode: `${fromDateStr} s/d ${toDateStr}`,
    days: dates.length,
    dates,
    omzet1: dates.map((d) => Math.round(omzet1[d])),
    omzet2: dates.map((d) => Math.round(omzet2[d])),
    laba1: dates.map((d) => Math.round(laba1[d])),
    laba2: dates.map((d) => Math.round(laba2[d])),
    totalOmzet1: Math.round(s1.omzet),
    totalOmzet2: Math.round(s2.omzet),
    totalLaba1: Math.round(s1.laba),
    totalLaba2: Math.round(s2.laba),
    totalTransaksi1: s1.jumlahTransaksi,
    totalTransaksi2: s2.jumlahTransaksi,
    allItems1: s1.allItems.map(([name, data]) => ({ name, qty: data.qty, omzet: Math.round(data.omzet) })),
    allItems2: s2.allItems.map((it) => ({
      name: it.name,
      qty: it.qty,
      omzet: Math.round(it.omzet),
      variants: it.variants.map((v) => ({ label: v.label, qty: v.qty, omzet: Math.round(v.omzet) })),
    })),
    debug: { receipts1: receipts1.length, receipts2: receipts2.length },
    refundLog2,
    variantTotals2,
    hourly1,
    hourly2,
    // [BARU] Perbandingan vs periode sebelumnya (panjang sama)
    comparison: {
      prevPeriode: `${prevFrom} s/d ${prevTo}`,
      omzetChange: calcPercentChange(s1.omzet + s2.omzet, totalOmzetPrev),
      omzetDiff: Math.round((s1.omzet + s2.omzet) - totalOmzetPrev),
      labaChange: calcPercentChange(s1.laba + s2.laba, totalLabaPrev),
      labaDiff: Math.round((s1.laba + s2.laba) - totalLabaPrev),
      transaksiChange: calcPercentChange(s1.jumlahTransaksi + s2.jumlahTransaksi, totalTransaksiPrev),
      transaksiDiff: (s1.jumlahTransaksi + s2.jumlahTransaksi) - totalTransaksiPrev,
    },
    beyond31Days,
    isDataEmpty,
    from: fromDateStr,
    to: toDateStr,
  };
}

// ================================================================
// === RENDER HTML DASHBOARD -- KASIR 1 POLOS, KASIR 2 BERTINGKAT +
// GRADASI EMAS (TIDAK DIUBAH SAMA SEKALI)
// ================================================================
function renderDashboardHTML(data: Awaited<ReturnType<typeof buildDashboardData>>): string {
  const fmt = (n: number) => "Rp" + Math.round(n).toLocaleString("id-ID");
  const today = getTodayDateStr();
  const yesterday = getYesterdayDateStr();
  const monthAgo = addMonthsToDateStr(today, -1);
  const firstDayMonthAgo = getFirstDayOfMonth(monthAgo);
  const lastDayMonthAgo = getLastDayOfMonth(monthAgo);

  const showUpgradeMessage = data.beyond31Days && data.isDataEmpty;

  // [BARU] Helper render badge perubahan persentase (mirip gaya Loyverse:
  // +Rp37.000 (+9,14%)). null berarti "Baru" (periode sebelumnya nol).
  const renderChangeBadge = (diff: number, pct: number | null, isMoney: boolean, invertColor: boolean = false): string => {
    if (pct === null) {
      return `<span class="text-xs text-gray-400 dark:text-gray-500">Baru (periode lalu Rp0)</span>`;
    }
    const positive = diff > 0;
    const neutral = diff === 0;
    // invertColor: dipakai untuk metrik dimana naik = kurang bagus (misal refund)
    const isGood = invertColor ? !positive : positive;
    const colorClass = neutral
      ? "text-gray-400 dark:text-gray-500"
      : isGood
        ? "text-green-600 dark:text-green-400"
        : "text-red-500 dark:text-red-400";
    const sign = positive ? "+" : diff < 0 ? "" : "";
    const diffText = isMoney ? fmt(diff) : `${diff}x`;
    return `<span class="text-xs ${colorClass}">${sign}${diffText} (${sign}${pct.toFixed(1)}%)</span>`;
  };

  const activeClass = (condition: boolean) =>
    condition
      ? "bg-amber-400 text-black border-amber-400 shadow-lg shadow-amber-400/30"
      : "bg-gray-100 text-gray-700 border-gray-300 hover:bg-gray-200 dark:bg-gray-700/50 dark:text-gray-300 dark:border-white/10 dark:hover:bg-gray-600";

  const kasir2Rows = data.allItems2
    .map((it) => {
      const parentRow = `<tr class="bg-gradient-to-r from-amber-500/20 to-amber-400/5 dark:from-amber-500/25 dark:to-amber-400/5 font-semibold border-b border-amber-500/20"><td class="py-2 px-2">${it.name}</td><td class="py-2 px-2">${it.qty}x</td><td class="py-2 px-2">${fmt(it.omzet)}</td></tr>`;
      const childRows = it.variants
        .map(
          (v) =>
            `<tr class="bg-amber-50/40 dark:bg-amber-900/10 text-gray-600 dark:text-gray-400 border-b border-gray-100 dark:border-slate-700/50"><td class="py-1.5 px-2 pl-6">↳ ${v.label}</td><td class="py-1.5 px-2">${v.qty}x</td><td class="py-1.5 px-2">${fmt(v.omzet)}</td></tr>`
        )
        .join("");
      return parentRow + childRows;
    })
    .join("");

  // [BARU] Baris tabel riwayat refund
  const refundRows = data.refundLog2
    .map(
      (rf) =>
        `<tr class="border-b border-gray-100 dark:border-slate-700/50">
          <td class="py-2 px-2 text-gray-400 dark:text-gray-500">${rf.time}</td>
          <td class="py-2 px-2 font-mono text-xs">${rf.receiptNumber}${rf.refundFor ? ` <span class="text-gray-400">(dari ${rf.refundFor})</span>` : ""}</td>
          <td class="py-2 px-2">${rf.itemName}</td>
          <td class="py-2 px-2 text-gray-500 dark:text-gray-400">${rf.variantName}</td>
          <td class="py-2 px-2">${rf.quantity}x</td>
          <td class="py-2 px-2 text-red-500 dark:text-red-400">-${fmt(rf.money)}</td>
        </tr>`
    )
    .join("");

  return `<!DOCTYPE html>
<html lang="id" class="dark">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.5" />
  <title>Dashboard Penjualan - Kedai Vitamart</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script>
    tailwind.config = {
      darkMode: 'class'
    }
  </script>
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
          ${data.comparison.omzetChange !== null || data.comparison.omzetDiff !== 0 ? ` ${renderChangeBadge(data.comparison.omzetDiff, data.comparison.omzetChange, true)}` : ''}
        </p>
        <p class="text-xs text-gray-400 dark:text-gray-500 mt-0.5">vs periode sebelumnya (${data.comparison.prevPeriode})</p>
      </div>
      <div class="flex items-center gap-2 mt-2 md:mt-0">
        ${data.refundLog2.length > 0 ? `
        <span class="inline-flex items-center gap-1 text-xs bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-300 px-3 py-1 rounded-full border border-red-200 dark:border-red-800">
          ↩️ ${data.refundLog2.length} refund
        </span>
        ` : ''}
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

    <!-- [BARU] Ringkasan perbandingan vs periode sebelumnya -->
    <div class="bg-white dark:bg-slate-800 rounded-xl shadow p-4 mb-6 border border-gray-200 dark:border-slate-700">
      <p class="text-xs text-gray-500 dark:text-gray-400 mb-2">📊 Dibanding periode sebelumnya (${data.comparison.prevPeriode})</p>
      <div class="flex flex-wrap gap-x-6 gap-y-2">
        <div>
          <span class="text-xs text-gray-400">Omzet: </span>
          ${renderChangeBadge(data.comparison.omzetDiff, data.comparison.omzetChange, true)}
        </div>
        <div>
          <span class="text-xs text-gray-400">Laba: </span>
          ${renderChangeBadge(data.comparison.labaDiff, data.comparison.labaChange, true)}
        </div>
        <div>
          <span class="text-xs text-gray-400">Transaksi: </span>
          ${renderChangeBadge(data.comparison.transaksiDiff, data.comparison.transaksiChange, false)}
        </div>
      </div>
    </div>

    <div class="bg-white dark:bg-slate-800 rounded-xl shadow p-4 md:p-6 mb-6 border border-gray-200 dark:border-slate-700">
      <div class="flex flex-wrap items-center justify-between gap-2 mb-3">
        <h2 class="text-base font-semibold">📈 Tren Omzet Harian</h2>
        <div class="flex gap-1.5">
          <button type="button" onclick="setChartType('trend','bar')" data-chart="trend" data-type="bar" class="chart-type-btn px-3 py-1 rounded-lg text-xs font-medium border transition bg-gray-100 text-gray-700 border-gray-300 hover:bg-gray-200 dark:bg-gray-700/50 dark:text-gray-300 dark:border-white/10 dark:hover:bg-gray-600">📊 Batang</button>
          <button type="button" onclick="setChartType('trend','line')" data-chart="trend" data-type="line" class="chart-type-btn px-3 py-1 rounded-lg text-xs font-medium border transition bg-amber-400 text-black border-amber-400 shadow-lg shadow-amber-400/30">📈 Garis</button>
          <button type="button" onclick="setChartType('trend','pie')" data-chart="trend" data-type="pie" class="chart-type-btn px-3 py-1 rounded-lg text-xs font-medium border transition bg-gray-100 text-gray-700 border-gray-300 hover:bg-gray-200 dark:bg-gray-700/50 dark:text-gray-300 dark:border-white/10 dark:hover:bg-gray-600">🥧 Pie</button>
        </div>
      </div>
      <div class="chart-container">
        <canvas id="trendChart"></canvas>
      </div>
    </div>

    <div class="bg-white dark:bg-slate-800 rounded-xl shadow p-4 md:p-6 mb-6 border border-gray-200 dark:border-slate-700">
      <div class="flex flex-wrap items-center justify-between gap-2 mb-3">
        <h2 class="text-base font-semibold">📊 Perbandingan Kasir</h2>
        <div class="flex gap-1.5">
          <button type="button" onclick="setChartType('compare','bar')" data-chart="compare" data-type="bar" class="chart-type-btn px-3 py-1 rounded-lg text-xs font-medium border transition bg-amber-400 text-black border-amber-400 shadow-lg shadow-amber-400/30">📊 Batang</button>
          <button type="button" onclick="setChartType('compare','line')" data-chart="compare" data-type="line" class="chart-type-btn px-3 py-1 rounded-lg text-xs font-medium border transition bg-gray-100 text-gray-700 border-gray-300 hover:bg-gray-200 dark:bg-gray-700/50 dark:text-gray-300 dark:border-white/10 dark:hover:bg-gray-600">📈 Garis</button>
          <button type="button" onclick="setChartType('compare','pie')" data-chart="compare" data-type="pie" class="chart-type-btn px-3 py-1 rounded-lg text-xs font-medium border transition bg-gray-100 text-gray-700 border-gray-300 hover:bg-gray-200 dark:bg-gray-700/50 dark:text-gray-300 dark:border-white/10 dark:hover:bg-gray-600">🥧 Pie</button>
        </div>
      </div>
      <div class="chart-container" style="height:220px;">
        <canvas id="compareChart"></canvas>
      </div>
    </div>

    <!-- [BARU] PENJUALAN PER JAM -- granularitas jam (00:00-23:00), digabung
         lintas-tanggal kalau periode lebih dari 1 hari, sama seperti
         laporan bawaan Loyverse. Beda dari "Tren Omzet Harian" di atas
         yang granularitasnya per tanggal. -->
    <div class="bg-white dark:bg-slate-800 rounded-xl shadow p-4 md:p-6 mb-6 border border-gray-200 dark:border-slate-700">
      <div class="flex flex-wrap items-center justify-between gap-2 mb-3">
        <h2 class="text-base font-semibold">🕐 Penjualan Per Jam</h2>
        <div class="flex gap-1.5">
          <button type="button" onclick="setChartType('hourly','bar')" data-chart="hourly" data-type="bar" class="chart-type-btn px-3 py-1 rounded-lg text-xs font-medium border transition bg-amber-400 text-black border-amber-400 shadow-lg shadow-amber-400/30">📊 Batang</button>
          <button type="button" onclick="setChartType('hourly','line')" data-chart="hourly" data-type="line" class="chart-type-btn px-3 py-1 rounded-lg text-xs font-medium border transition bg-gray-100 text-gray-700 border-gray-300 hover:bg-gray-200 dark:bg-gray-700/50 dark:text-gray-300 dark:border-white/10 dark:hover:bg-gray-600">📈 Garis</button>
        </div>
      </div>
      <p class="text-xs text-gray-400 dark:text-gray-500 mb-2">Jam digabung dari semua tanggal di periode terpilih (${data.periode})</p>
      <div class="chart-container">
        <canvas id="hourlyChart"></canvas>
      </div>
    </div>

    <!-- KASIR 1: POLOS, TIDAK DIUBAH -->
    <div class="bg-white dark:bg-slate-800 rounded-xl shadow p-4 md:p-6 mb-6 border border-gray-200 dark:border-slate-700">
      <h2 class="text-base font-semibold mb-3">📦 Semua Item Terjual - Kasir 1</h2>
      ${data.allItems1.length ? `
      <div class="table-scroll">
        <table class="w-full text-sm">
          <thead class="text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-slate-700">
            <tr><th class="text-left py-2">Item</th><th class="text-left py-2">Qty</th><th class="text-left py-2">Omzet</th></tr>
          </thead>
          <tbody>
            ${data.allItems1.map((it) => `<tr class="border-b border-gray-100 dark:border-slate-700/50"><td class="py-2">${it.name}</td><td class="py-2">${it.qty}x</td><td class="py-2">${fmt(it.omzet)}</td></tr>`).join("")}
          </tbody>
        </table>
      </div>
      ` : `<p class="text-gray-400 text-sm py-4 text-center">${showUpgradeMessage ? '🔒 Upgrade untuk lihat data historis' : 'Tidak ada data'}</p>`}
    </div>

    <!-- KASIR 2: BERTINGKAT + GRADASI EMAS -->
    <div class="bg-white dark:bg-slate-800 rounded-xl shadow p-4 md:p-6 mb-6 border border-amber-500/30">
      <h2 class="text-base font-semibold mb-3 flex items-center gap-2">
        📦 Semua Item Terjual - Kasir 2
        <span class="text-xs font-normal text-amber-500 bg-amber-500/10 px-2 py-0.5 rounded-full">dengan varian</span>
      </h2>
      ${data.allItems2.length ? `
      <div class="table-scroll">
        <table class="w-full text-sm rounded-lg overflow-hidden">
          <thead class="bg-gradient-to-r from-amber-500 to-amber-400 text-black">
            <tr><th class="text-left py-2 px-2">Item</th><th class="text-left py-2 px-2">Qty</th><th class="text-left py-2 px-2">Omzet</th></tr>
          </thead>
          <tbody>
            ${kasir2Rows}
          </tbody>
        </table>
      </div>
      ` : `<p class="text-gray-400 text-sm py-4 text-center">${showUpgradeMessage ? '🔒 Upgrade untuk lihat data historis' : 'Tidak ada data'}</p>`}
    </div>

    <!-- [BARU] TOTAL GABUNGAN VARIAN NORMAL vs CUP BESAR (lintas item) -->
    <div class="bg-white dark:bg-slate-800 rounded-xl shadow p-4 md:p-6 mb-6 border border-blue-400/30">
      <h2 class="text-base font-semibold mb-3 flex items-center gap-2">
        📐 Total Semua Varian - Kasir 2
        <span class="text-xs font-normal text-blue-500 bg-blue-500/10 px-2 py-0.5 rounded-full">gabungan lintas item</span>
      </h2>
      <div class="table-scroll">
        <table class="w-full text-sm">
          <thead class="text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-slate-700">
            <tr><th class="text-left py-2">Varian</th><th class="text-left py-2">Qty</th><th class="text-left py-2">Omzet</th></tr>
          </thead>
          <tbody>
            <tr class="border-b border-gray-100 dark:border-slate-700/50">
              <td class="py-2">Normal (Cup Kecil)</td>
              <td class="py-2">${data.variantTotals2.normal.qty}x</td>
              <td class="py-2">${fmt(data.variantTotals2.normal.omzet)}</td>
            </tr>
            <tr class="border-b border-gray-100 dark:border-slate-700/50">
              <td class="py-2">Cup Besar</td>
              <td class="py-2">${data.variantTotals2.cupbesar.qty}x</td>
              <td class="py-2">${fmt(data.variantTotals2.cupbesar.omzet)}</td>
            </tr>
            <tr class="font-semibold bg-blue-500/5">
              <td class="py-2">Total</td>
              <td class="py-2">${data.variantTotals2.normal.qty + data.variantTotals2.cupbesar.qty}x</td>
              <td class="py-2">${fmt(data.variantTotals2.normal.omzet + data.variantTotals2.cupbesar.omzet)}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="text-xs text-gray-400 dark:text-gray-500 mt-3">
        Tidak termasuk item mandiri (dihitung sendiri, bukan digabung ke sini): ${data.variantTotals2.excludedNames.map(n => n.replace(/\b\w/g, c => c.toUpperCase())).join(', ')}
      </p>
    </div>

    <!-- RIWAYAT REFUND (BARU) - Khusus Kasir 2, buat audit -->
    <div class="bg-white dark:bg-slate-800 rounded-xl shadow p-4 md:p-6 mb-6 border ${data.refundLog2.length ? 'border-red-400/30' : 'border-gray-200 dark:border-slate-700'}">
      <h2 class="text-base font-semibold mb-3 flex items-center gap-2">
        ↩️ Riwayat Refund - Kasir 2
        ${data.refundLog2.length
          ? `<span class="text-xs font-normal text-red-500 bg-red-500/10 px-2 py-0.5 rounded-full">${data.refundLog2.length} transaksi</span>`
          : `<span class="text-xs font-normal text-gray-400 bg-gray-400/10 px-2 py-0.5 rounded-full">tidak ada</span>`}
      </h2>
      ${data.refundLog2.length ? `
      <div class="table-scroll">
        <table class="w-full text-sm">
          <thead class="text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-slate-700">
            <tr>
              <th class="text-left py-2 px-2">Jam</th>
              <th class="text-left py-2 px-2">Receipt</th>
              <th class="text-left py-2 px-2">Item</th>
              <th class="text-left py-2 px-2">Varian</th>
              <th class="text-left py-2 px-2">Qty</th>
              <th class="text-left py-2 px-2">Nominal</th>
            </tr>
          </thead>
          <tbody>
            ${refundRows}
          </tbody>
        </table>
      </div>
      ` : `<p class="text-gray-400 text-sm py-4 text-center">Tidak ada refund di periode ini 👍</p>`}
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
    const totalOmzet1 = ${data.totalOmzet1};
    const totalOmzet2 = ${data.totalOmzet2};
    const totalLaba1 = ${data.totalLaba1};
    const totalLaba2 = ${data.totalLaba2};
    const hourly1 = ${JSON.stringify(data.hourly1)};
    const hourly2 = ${JSON.stringify(data.hourly2)};
    const hourLabels = Array.from({length: 24}, (_, i) => String(i).padStart(2, '0') + ':00');

    function themeColor() {
      return document.documentElement.classList.contains('dark') ? '#94a3b8' : '#64748b';
    }
    function legendColor() {
      return document.documentElement.classList.contains('dark') ? '#cbd5e1' : '#1e293b';
    }

    const pieColors = ['#3b82f6', '#10b981', '#f59e0b', '#ec4899'];

    function pieLegendWithPercent(chart) {
      const ds = chart.data.datasets[0];
      const total = ds.data.reduce((a, b) => a + b, 0);
      return chart.data.labels.map((label, i) => {
        const value = ds.data[i];
        const pct = total > 0 ? ((value / total) * 100).toFixed(1) : '0';
        return {
          text: label + ' - ' + pct + '%',
          fillStyle: ds.backgroundColor[i],
          fontColor: legendColor(),
          strokeStyle: ds.backgroundColor[i],
          index: i
        };
      });
    }

    let trendChartInstance = null;
    let compareChartInstance = null;
    let hourlyChartInstance = null;

    function renderTrendChart(type) {
      if (trendChartInstance) trendChartInstance.destroy();
      const ctx = document.getElementById('trendChart');

      if (type === 'pie') {
        trendChartInstance = new Chart(ctx, {
          type: 'pie',
          data: {
            labels: ['Kasir 1', 'Kasir 2'],
            datasets: [{ data: [totalOmzet1, totalOmzet2], backgroundColor: [pieColors[0], pieColors[1]] }]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
              legend: {
                labels: { color: legendColor(), generateLabels: (chart) => pieLegendWithPercent(chart) }
              },
              tooltip: {
                callbacks: {
                  label: (ctx) => {
                    const total = ctx.dataset.data.reduce((a, b) => a + b, 0);
                    const pct = total > 0 ? ((ctx.parsed / total) * 100).toFixed(1) : '0';
                    return ctx.label + ': Rp' + ctx.parsed.toLocaleString('id-ID') + ' (' + pct + '%)';
                  }
                }
              }
            }
          }
        });
      } else {
        trendChartInstance = new Chart(ctx, {
          type: type,
          data: {
            labels: dates,
            datasets: [
              { label: 'Kasir 1', data: omzet1, borderColor: '#3b82f6', backgroundColor: type === 'bar' ? '#3b82f6' : 'rgba(59,130,246,0.1)', fill: type === 'line', tension: 0.3 },
              { label: 'Kasir 2', data: omzet2, borderColor: '#10b981', backgroundColor: type === 'bar' ? '#10b981' : 'rgba(16,185,129,0.1)', fill: type === 'line', tension: 0.3 }
            ]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: { duration: 800, easing: 'easeInOutQuart' },
            plugins: { legend: { labels: { color: legendColor() } } },
            scales: {
              x: { ticks: { color: themeColor(), maxRotation: 30, autoSkip: true, maxTicksLimit: 20 } },
              y: { ticks: { color: themeColor(), callback: v => 'Rp' + Number(v).toLocaleString('id-ID') } }
            }
          }
        });
      }
    }

    function renderCompareChart(type) {
      if (compareChartInstance) compareChartInstance.destroy();
      const ctx = document.getElementById('compareChart');

      if (type === 'pie') {
        compareChartInstance = new Chart(ctx, {
          type: 'pie',
          data: {
            labels: ['Kasir 1 - Omzet', 'Kasir 1 - Laba', 'Kasir 2 - Omzet', 'Kasir 2 - Laba'],
            datasets: [{
              data: [totalOmzet1, totalLaba1, totalOmzet2, totalLaba2],
              backgroundColor: pieColors
            }]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
              legend: {
                labels: { color: legendColor(), generateLabels: (chart) => pieLegendWithPercent(chart) }
              },
              tooltip: {
                callbacks: {
                  label: (ctx) => {
                    const total = ctx.dataset.data.reduce((a, b) => a + b, 0);
                    const pct = total > 0 ? ((ctx.parsed / total) * 100).toFixed(1) : '0';
                    return ctx.label + ': Rp' + ctx.parsed.toLocaleString('id-ID') + ' (' + pct + '%)';
                  }
                }
              }
            }
          }
        });
      } else {
        compareChartInstance = new Chart(ctx, {
          type: type,
          data: {
            labels: ['Omzet', 'Laba'],
            datasets: [
              { label: 'Kasir 1', data: [totalOmzet1, totalLaba1], backgroundColor: '#3b82f6', borderColor: '#3b82f6' },
              { label: 'Kasir 2', data: [totalOmzet2, totalLaba2], backgroundColor: '#10b981', borderColor: '#10b981' }
            ]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: { duration: 800, easing: 'easeInOutQuart' },
            plugins: { legend: { labels: { color: legendColor() } } },
            scales: {
              x: { ticks: { color: themeColor() } },
              y: { ticks: { color: themeColor(), callback: v => 'Rp' + Number(v).toLocaleString('id-ID') } }
            }
          }
        });
      }
    }

    function renderHourlyChart(type) {
      if (hourlyChartInstance) hourlyChartInstance.destroy();
      const ctx = document.getElementById('hourlyChart');
      hourlyChartInstance = new Chart(ctx, {
        type: type,
        data: {
          labels: hourLabels,
          datasets: [
            { label: 'Kasir 1', data: hourly1, borderColor: '#3b82f6', backgroundColor: type === 'bar' ? '#3b82f6' : 'rgba(59,130,246,0.1)', fill: type === 'line', tension: 0.3 },
            { label: 'Kasir 2', data: hourly2, borderColor: '#10b981', backgroundColor: type === 'bar' ? '#10b981' : 'rgba(16,185,129,0.1)', fill: type === 'line', tension: 0.3 }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: { duration: 800, easing: 'easeInOutQuart' },
          plugins: { legend: { labels: { color: legendColor() } } },
          scales: {
            x: { ticks: { color: themeColor(), maxRotation: 0, autoSkip: true, maxTicksLimit: 12 } },
            y: { ticks: { color: themeColor(), callback: v => 'Rp' + Number(v).toLocaleString('id-ID') } }
          }
        }
      });
    }

    function setChartType(chartName, type) {
      const buttons = document.querySelectorAll('.chart-type-btn[data-chart="' + chartName + '"]');
      buttons.forEach(btn => {
        const isActive = btn.getAttribute('data-type') === type;
        btn.className = 'chart-type-btn px-3 py-1 rounded-lg text-xs font-medium border transition ' +
          (isActive
            ? 'bg-amber-400 text-black border-amber-400 shadow-lg shadow-amber-400/30'
            : 'bg-gray-100 text-gray-700 border-gray-300 hover:bg-gray-200 dark:bg-gray-700/50 dark:text-gray-300 dark:border-white/10 dark:hover:bg-gray-600');
      });
      if (chartName === 'trend') renderTrendChart(type);
      else if (chartName === 'hourly') renderHourlyChart(type);
      else renderCompareChart(type);
    }

    renderTrendChart('line');
    renderCompareChart('bar');
    renderHourlyChart('bar');
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