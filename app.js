/**
 * 壳记账 — 主应用逻辑 v3 (云端同步版)
 * 数据存储: Supabase 云端 + localStorage 缓存
 */

// ============================================
// Supabase 连接
// ============================================

const SUPABASE_URL = 'https://ylvrtjrhokfxejqsnhqx.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlsdnJ0anJob2tmeGVqcXNuaHF4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMyOTk0NDksImV4cCI6MjA4ODg3NTQ0OX0.L_N_74qYBdDt0gUaG9jB_MtWZmj0Ik_3tn4N-l1DvA8';

let sb = null;
let cloudEnabled = false;

try {
    sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
} catch (e) {
    console.warn('Supabase 客户端初始化失败:', e);
}

// 内存缓存（所有读操作从这里取，保证速度）
const cache = {};

// 超时包装器
function withTimeout(promise, ms = 8000) {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('请求超时')), ms))
    ]);
}


// ============================================
// 数据层（云端 + 本地缓存）
// ============================================

const KEYS = {
    PURCHASES: 'shell_purchases',
    SALES: 'shell_sales',
    RETURNS: 'shell_returns',
    SUPPLIES: 'shell_supplies',
    PROMOTIONS: 'shell_promotions',
    ORDERS: 'shell_orders',
    FACTORIES: 'shell_factories',
    DESIGNS: 'shell_designs',
    SUPPLY_CATS: 'shell_supply_cats'
};

function genId() { return Date.now().toString(36) + Math.random().toString(36).substr(2, 6); }
function getToday() { return new Date().toISOString().split('T')[0]; }
function fmt(n) { return (n === undefined || n === null || isNaN(n)) ? '0.00' : Number(n).toFixed(2); }

// 从缓存读取（同步，快速）
function getStore(key) {
    if (cache[key] !== undefined) return cache[key];
    try { return JSON.parse(localStorage.getItem(key)) || []; } catch { return []; }
}

// 写入缓存 + 异步推到云端
function setStore(key, data) {
    cache[key] = data;
    localStorage.setItem(key, JSON.stringify(data));
    pushToCloud(key, data); // 异步推云端，不阻塞
}

// 异步推送到 Supabase
async function pushToCloud(key, data) {
    if (!sb || !cloudEnabled) return;
    try {
        await withTimeout(sb.from('kv_store').upsert({
            key: key,
            value: data,
            updated_at: new Date().toISOString()
        }));
        updateSyncStatus('synced');
    } catch (err) {
        console.warn('云端同步失败:', err);
        updateSyncStatus('error');
    }
}

// 从 Supabase 拉取全部数据
async function pullFromCloud() {
    if (!sb) {
        loadLocalData();
        updateSyncStatus('error');
        return false;
    }
    try {
        updateSyncStatus('syncing');
        const { data, error } = await withTimeout(sb.from('kv_store').select('*'));
        if (error) throw error;
        if (data && data.length > 0) {
            data.forEach(row => {
                cache[row.key] = row.value || [];
                localStorage.setItem(row.key, JSON.stringify(row.value || []));
            });
        } else {
            // 云端没数据，用本地数据初始化云端
            for (const key of Object.values(KEYS)) {
                const local = getStore(key);
                cache[key] = local;
                if (local.length > 0) pushToCloud(key, local);
            }
        }
        cloudEnabled = true;
        updateSyncStatus('synced');
        return true;
    } catch (err) {
        console.warn('拉取云端数据失败:', err);
        updateSyncStatus('error');
        loadLocalData();
        return false;
    }
}

// 降级到本地数据
function loadLocalData() {
    for (const key of Object.values(KEYS)) {
        cache[key] = getStore(key);
    }
}

// 同步状态UI
function updateSyncStatus(status) {
    const el = document.getElementById('syncStatus');
    if (!el) return;
    switch (status) {
        case 'syncing':
            el.textContent = '☁️ 同步中...';
            el.className = 'sync-status syncing';
            break;
        case 'synced':
            el.textContent = '✅ 已同步';
            el.className = 'sync-status synced';
            break;
        case 'error':
            el.textContent = '⚠️ 离线模式';
            el.className = 'sync-status error';
            break;
    }
}

// 手动同步
async function manualSync() {
    await pullFromCloud();
    refreshAll();
    showToast('数据已从云端同步 ✓');
}

// 保存常用值
function saveToList(key, val) {
    if (!val) return;
    const list = getStore(key);
    if (!list.includes(val)) { list.push(val); setStore(key, list); }
}


// ============================================
// 业务数据操作
// ============================================

// --- 进货 ---
function getPurchases() { return getStore(KEYS.PURCHASES); }
function addPurchase(item) {
    const list = getPurchases();
    const record = {
        id: genId(), date: item.date || getToday(),
        factory: item.factory.trim(), design: item.design.trim(), model: item.model.trim(),
        quantity: Number(item.quantity), unitCost: 0, totalCost: 0,
        note: item.note || '', createdAt: Date.now()
    };
    list.unshift(record);
    setStore(KEYS.PURCHASES, list);
    saveToList(KEYS.FACTORIES, item.factory.trim());
    saveToList(KEYS.DESIGNS, item.design.trim());
    return record;
}
function deletePurchase(id) { setStore(KEYS.PURCHASES, getPurchases().filter(p => p.id !== id)); }

// --- 销售 ---
function getSales() { return getStore(KEYS.SALES); }
function addSale(item) {
    const list = getSales();
    const qty = Number(item.quantity), sp = Number(item.sellingPrice), pc = Number(item.purchaseCost);
    const lo = Number(item.logistics), pk = Number(item.packaging), ins = Number(item.insurance);
    const commRate = Number(item.commission) || 0;
    const commAmount = sp * commRate * qty;
    const totalRevenue = sp * qty, totalCost = (pc + lo + pk + ins) * qty + commAmount;
    const record = {
        id: genId(), date: item.date || getToday(), platform: item.platform,
        design: (item.design || '').trim(), model: item.model.trim(),
        quantity: qty, sellingPrice: sp, purchaseCost: pc,
        logistics: lo, packaging: pk, insurance: ins,
        commission: commRate, commissionAmount: commAmount,
        totalRevenue, totalCost, profit: totalRevenue - totalCost,
        note: item.note || '', createdAt: Date.now()
    };
    list.unshift(record);
    setStore(KEYS.SALES, list);
    return record;
}
function deleteSale(id) { setStore(KEYS.SALES, getSales().filter(s => s.id !== id)); }

// --- 退货 ---
function getReturns() { return getStore(KEYS.RETURNS); }
function addReturn(item) {
    const list = getReturns();
    const record = {
        id: genId(), date: item.date || getToday(), platform: item.platform,
        design: (item.design || '').trim(), model: item.model.trim(),
        quantity: Number(item.quantity), refundAmount: Number(item.refundAmount),
        reason: item.reason || '', createdAt: Date.now()
    };
    list.unshift(record);
    setStore(KEYS.RETURNS, list);
    return record;
}
function deleteReturn(id) { setStore(KEYS.RETURNS, getReturns().filter(r => r.id !== id)); }

// --- 辅料 ---
function getSupplies() { return getStore(KEYS.SUPPLIES); }
function addSupply(item) {
    const list = getSupplies();
    const record = {
        id: genId(), date: item.date || getToday(),
        category: item.category.trim(), name: item.name.trim(),
        quantity: Number(item.quantity), amount: Number(item.amount),
        note: item.note || '', createdAt: Date.now()
    };
    list.unshift(record);
    setStore(KEYS.SUPPLIES, list);
    saveToList(KEYS.SUPPLY_CATS, item.category.trim());
    return record;
}
function deleteSupply(id) { setStore(KEYS.SUPPLIES, getSupplies().filter(s => s.id !== id)); }

// --- 常用列表 ---
function getFactories() { return getStore(KEYS.FACTORIES); }
function getDesigns() { return getStore(KEYS.DESIGNS); }
function getSupplyCats() { return getStore(KEYS.SUPPLY_CATS); }

// --- 库存汇总 ---
function getInventorySummary() {
    const purchases = getPurchases(), sales = getSales(), returns = getReturns();
    const map = {};
    const key = (d, m) => d + '|||' + m;

    purchases.forEach(p => {
        const k = key(p.design, p.model);
        if (!map[k]) map[k] = { design: p.design, model: p.model, totalPurchased: 0, totalSold: 0, totalReturned: 0, totalPurchaseCost: 0, purchaseRecords: 0 };
        map[k].totalPurchased += p.quantity;
        map[k].totalPurchaseCost += p.totalCost;
        map[k].purchaseRecords++;
    });

    sales.forEach(s => {
        const k = key(s.design || '', s.model);
        if (!map[k]) map[k] = { design: s.design || '', model: s.model, totalPurchased: 0, totalSold: 0, totalReturned: 0, totalPurchaseCost: 0, purchaseRecords: 0 };
        map[k].totalSold += s.quantity;
    });

    returns.forEach(r => {
        const k = key(r.design || '', r.model);
        if (map[k]) map[k].totalReturned += r.quantity;
    });

    return Object.values(map).map(m => {
        const stock = Math.max(0, m.totalPurchased - m.totalSold + m.totalReturned);
        const avg = m.purchaseRecords > 0 ? m.totalPurchaseCost / m.totalPurchased : 0;
        return { ...m, stock, avgCost: Math.round(avg * 100) / 100, stockValue: Math.round(stock * avg * 100) / 100 };
    }).sort((a, b) => b.stockValue - a.stockValue);
}

// --- 月度报表 ---
function getMonthlyReport(year, month) {
    const prefix = `${year}-${String(month).padStart(2, '0')}`;
    const ms = getSales().filter(s => s.date.startsWith(prefix));
    const mp = getPurchases().filter(p => p.date.startsWith(prefix));
    const mr = getReturns().filter(r => r.date.startsWith(prefix));
    const msup = getSupplies().filter(s => s.date.startsWith(prefix));
    const mpromo = getStore(KEYS.PROMOTIONS).filter(p => p.date && p.date.startsWith(prefix));
    const morders = getStore(KEYS.ORDERS).filter(o => o.date && o.date.startsWith(prefix));

    const totalRevenue = ms.reduce((s, x) => s + x.totalRevenue, 0);
    const totalCost = ms.reduce((s, x) => s + x.totalCost, 0);
    const totalRefund = mr.reduce((s, x) => s + (x.refundAmount || 0), 0);
    const totalSupplies = msup.reduce((s, x) => s + x.amount, 0);
    const totalPromo = mpromo.reduce((s, x) => s + x.amount, 0);
    const totalOrders = morders.reduce((s, x) => s + x.amount, 0);
    const grossProfit = totalRevenue - totalCost - totalRefund - totalSupplies - totalPromo - totalOrders;

    const pb = {};
    ms.forEach(s => {
        if (!pb[s.platform]) pb[s.platform] = { revenue: 0, cost: 0, qty: 0, profit: 0 };
        pb[s.platform].revenue += s.totalRevenue;
        pb[s.platform].cost += s.totalCost;
        pb[s.platform].qty += s.quantity;
        pb[s.platform].profit += s.profit;
    });

    return {
        totalRevenue: Math.round(totalRevenue * 100) / 100,
        totalCost: Math.round(totalCost * 100) / 100,
        totalRefund: Math.round(totalRefund * 100) / 100,
        totalSupplies: Math.round(totalSupplies * 100) / 100,
        totalPromo: Math.round(totalPromo * 100) / 100,
        totalOrders: Math.round(totalOrders * 100) / 100,
        grossProfit: Math.round(grossProfit * 100) / 100,
        totalSoldQty: ms.reduce((s, x) => s + x.quantity, 0),
        totalReturnQty: mr.reduce((s, x) => s + x.quantity, 0),
        totalPurchaseSpend: Math.round(mp.reduce((s, x) => s + x.totalCost, 0) * 100) / 100,
        profitRate: totalRevenue > 0 ? Math.round(grossProfit / totalRevenue * 10000) / 100 : 0,
        platformBreakdown: pb,
        purchaseCount: mp.length,
        suppliesCount: msup.length
    };
}

function getFactorySummary(year) {
    const ps = year ? getPurchases().filter(p => p.date.startsWith(String(year))) : getPurchases();
    const map = {};
    ps.forEach(p => {
        if (!map[p.factory]) map[p.factory] = { factory: p.factory, totalAmount: 0, totalQty: 0, orders: 0 };
        map[p.factory].totalAmount += p.totalCost;
        map[p.factory].totalQty += p.quantity;
        map[p.factory].orders++;
    });
    return Object.values(map).map(f => ({ ...f, totalAmount: Math.round(f.totalAmount * 100) / 100 })).sort((a, b) => b.totalAmount - a.totalAmount);
}

function getMonthlyTrend() {
    const now = new Date(), result = [];
    for (let i = 5; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        const r = getMonthlyReport(d.getFullYear(), d.getMonth() + 1);
        result.push({ label: (d.getMonth() + 1) + '月', revenue: r.totalRevenue, profit: r.grossProfit });
    }
    return result;
}

// --- CSV ---
function generateCSV() {
    const BOM = '\uFEFF';
    let csv = '';
    csv += '【进货记录】\n日期,工厂,款名,型号,数量,单价,总金额,备注\n';
    getPurchases().forEach(p => { csv += `${p.date},${p.factory},${p.design},${p.model},${p.quantity},${p.unitCost},${p.totalCost},${p.note}\n`; });

    csv += '\n【辅料采购】\n日期,类目,品名,数量,金额,备注\n';
    getSupplies().forEach(s => { csv += `${s.date},${s.category},${s.name},${s.quantity},${s.amount},${s.note}\n`; });

    csv += '\n【销售记录】\n日期,平台,款名,型号,数量,售价,进货价,物流,包装,运费险,总收入,总成本,利润,备注\n';
    getSales().forEach(s => { csv += `${s.date},${s.platform},${s.design},${s.model},${s.quantity},${s.sellingPrice},${s.purchaseCost},${s.logistics},${s.packaging},${s.insurance},${s.totalRevenue},${s.totalCost},${s.profit},${s.note}\n`; });

    csv += '\n【退货记录】\n日期,平台,款名,型号,数量,退款金额,原因\n';
    getReturns().forEach(r => { csv += `${r.date},${r.platform},${r.design},${r.model},${r.quantity},${r.refundAmount},${r.reason}\n`; });

    csv += '\n【库存汇总】\n款名,型号,进货总量,已售总量,退货总量,库存量,进货均价,积压成本\n';
    getInventorySummary().forEach(i => { csv += `${i.design},${i.model},${i.totalPurchased},${i.totalSold},${i.totalReturned},${i.stock},${i.avgCost},${i.stockValue}\n`; });

    return BOM + csv;
}


// ============================================
// 登录验证
// ============================================

const AUTH_USER = 'shoremoon';
const AUTH_PASS = 'shoremoon1328';

function isLoggedIn() {
    return sessionStorage.getItem('shell_auth') === 'true';
}

function doLogin() {
    const user = document.getElementById('login-user').value.trim();
    const pass = document.getElementById('login-pass').value.trim();
    if (user === AUTH_USER && pass === AUTH_PASS) {
        sessionStorage.setItem('shell_auth', 'true');
        document.getElementById('login-overlay').style.display = 'none';
        document.getElementById('sidebar').style.display = '';
        document.getElementById('mainContent').style.display = '';
        initApp();
    } else {
        document.getElementById('login-error').classList.add('show');
        const card = document.getElementById('login-card');
        card.classList.remove('shake');
        void card.offsetWidth; // 触发重排以重新启动动画
        card.classList.add('shake');
        setTimeout(() => document.getElementById('login-error').classList.remove('show'), 3000);
    }
}

// 密码框回车登录
document.addEventListener('DOMContentLoaded', () => {
    const passInput = document.getElementById('login-pass');
    const userInput = document.getElementById('login-user');
    if (passInput) passInput.addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
    if (userInput) userInput.addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('login-pass').focus(); });
});


// ============================================
// UI 控制
// ============================================

let currentView = 'dashboard';
let currentPlatform = '淘宝';
let returnPlatform = '淘宝';
let salesFilter = '';
let reportYear, reportMonth;
let invViewMode = 'design';

// --- 初始化 ---
window.addEventListener('DOMContentLoaded', async () => {
    // 已登录则跳过登录页
    if (isLoggedIn()) {
        document.getElementById('login-overlay').style.display = 'none';
        document.getElementById('sidebar').style.display = '';
        document.getElementById('mainContent').style.display = '';
        initApp();
    }
});

async function initApp() {
    const today = getToday();
    document.getElementById('currentDate').textContent = today;
    ['p-date', 's-date', 'r-date', 'sup-date'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = today;
    });
    const now = new Date();
    reportYear = now.getFullYear();
    reportMonth = now.getMonth() + 1;
    bindFormListeners();
    setupModelAutocomplete('s-model', 's-model-list');
    setupModelAutocomplete('r-model', 'r-model-list');
    setupModelAutocomplete('p-model', 'p-model-list');

    // 绑定同步按钮
    document.getElementById('syncStatus').addEventListener('click', manualSync);

    // 先从云端拉数据
    await pullFromCloud();

    // 隐藏加载遮罩
    document.getElementById('loading-overlay').style.display = 'none';

    refreshAll();

    // 每60秒自动同步一次
    setInterval(async () => {
        await pullFromCloud();
        refreshAll();
    }, 60000);
}

function refreshAll() {
    renderDashboard();
    renderPurchases();
    renderSupplies();
    renderSalesPage();
    renderReturns();
    renderInventory();
    renderReport();
    renderPromotion();
    renderOrders();
    updateExpenseBreakdown();
}

// --- 视图切换 ---
function switchView(view) {
    document.querySelectorAll('.nav-item').forEach(el => el.classList.toggle('active', el.dataset.view === view));
    document.querySelectorAll('.view').forEach(el => el.classList.toggle('active', el.id === 'view-' + view));
    const titles = { dashboard: '首页概览', purchase: '📦 进货记录', supplies: '🎁 辅料采购', sales: '💰 销售记录', returns: '↩️ 退货记录', inventory: '📋 库存管理', report: '📈 月度报表' };
    document.getElementById('pageTitle').textContent = titles[view] || view;
    currentView = view;
    document.getElementById('sidebar').classList.remove('open');
    refreshAll();
}

function toggleSidebar() { document.getElementById('sidebar').classList.toggle('open'); }
document.getElementById('sidebarClose').addEventListener('click', () => document.getElementById('sidebar').classList.remove('open'));

function showToast(msg, isError = false) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.className = 'toast' + (isError ? ' error' : '');
    setTimeout(() => t.classList.add('show'), 10);
    setTimeout(() => t.classList.remove('show'), 2500);
}

let modalCallback = null;
function showModal(title, content, onConfirm) {
    document.getElementById('modal-title').textContent = title;
    document.getElementById('modal-content').textContent = content;
    document.getElementById('modal-overlay').style.display = 'flex';
    modalCallback = onConfirm;
    document.getElementById('modal-confirm').onclick = () => { if (modalCallback) modalCallback(); closeModal(); };
}
function closeModal() { document.getElementById('modal-overlay').style.display = 'none'; modalCallback = null; }

function toggleForm(type) {
    const form = document.getElementById(type + '-form');
    const arrow = document.getElementById(type + '-arrow');
    if (form.style.display === 'none') { form.style.display = 'block'; arrow.textContent = '▲'; }
    else { form.style.display = 'none'; arrow.textContent = '▼'; }
}

function toggleCostDetail() {
    const detail = document.getElementById('cost-detail');
    const preview = document.getElementById('cost-preview');
    const text = document.getElementById('cost-toggle-text');
    if (detail.style.display === 'none') { detail.style.display = 'block'; preview.style.display = 'none'; text.textContent = '收起 ▲'; }
    else { detail.style.display = 'none'; preview.style.display = 'block'; text.textContent = '调整 ▼'; updateCostPreview(); }
}

function updateCostPreview() {
    const l = document.getElementById('s-logistics').value || 4;
    const p = document.getElementById('s-packaging').value || 3;
    const i = document.getElementById('s-insurance').value || 1.5;
    document.getElementById('cost-preview').textContent = `物流${l} + 包装${p} + 运费险${i} = ${Number(l) + Number(p) + Number(i)}元/件`;
}

function selectPlatform(p) {
    currentPlatform = p;
    document.getElementById('btn-taobao').classList.toggle('active', p === '淘宝');
    document.getElementById('btn-xhs').classList.toggle('active', p === '小红书');
    document.getElementById('btn-douyin').classList.toggle('active', p === '抖音');
}

function selectReturnPlatform(p) {
    returnPlatform = p;
    document.getElementById('rbtn-taobao').classList.toggle('active', p === '淘宝');
    document.getElementById('rbtn-xhs').classList.toggle('active', p === '小红书');
    document.getElementById('rbtn-douyin').classList.toggle('active', p === '抖音');
}

function setInvView(mode) {
    invViewMode = mode;
    document.getElementById('inv-by-design').classList.toggle('active', mode === 'design');
    document.getElementById('inv-by-model').classList.toggle('active', mode === 'model');
    renderInventory();
}

// --- 表单实时计算 ---
function bindFormListeners() {
    const sQty = document.getElementById('s-quantity'), sPrice = document.getElementById('s-price'), sCost = document.getElementById('s-cost');
    const sL = document.getElementById('s-logistics'), sP = document.getElementById('s-packaging'), sI = document.getElementById('s-insurance');
    function updS() {
        const q = Number(sQty.value), sp = Number(sPrice.value), pc = Number(sCost.value);
        const lo = Number(sL.value) || 4, pk = Number(sP.value) || 3, ins = Number(sI.value) || 1.5;
        const commRate = Number(document.querySelector('input[name="s-commission"]:checked')?.value) || 0;
        if (q > 0 && sp > 0 && pc > 0) {
            const rev = sp * q, commAmount = sp * commRate * q, cost = (pc + lo + pk + ins) * q + commAmount, profit = rev - cost;
            document.getElementById('s-profit-preview').style.display = 'block';
            document.getElementById('sp-revenue').textContent = '+¥' + fmt(rev);
            document.getElementById('sp-cost').textContent = '-¥' + fmt(cost);
            document.getElementById('sp-profit').textContent = '¥' + fmt(profit);
            document.getElementById('sp-profit').className = 'profit-big ' + (profit >= 0 ? 'success' : 'danger');
        } else { document.getElementById('s-profit-preview').style.display = 'none'; }
    }
    [sQty, sPrice, sCost, sL, sP, sI].forEach(el => el.addEventListener('input', updS));
    [sL, sP, sI].forEach(el => el.addEventListener('input', updateCostPreview));
    document.querySelectorAll('input[name="s-commission"]').forEach(r => r.addEventListener('change', updS));
}




// ============================================
// 首页
// ============================================

let dashYear = new Date().getFullYear();
let dashMonth = new Date().getMonth() + 1;

function renderDashboard() {
    const report = getMonthlyReport(dashYear, dashMonth);

    document.getElementById('dash-month-label').textContent = dashYear + '年' + dashMonth + '月';
    document.getElementById('kpi-revenue-label').textContent = dashMonth + '月销售额';
    document.getElementById('kpi-profit-label').textContent = dashMonth + '月利润';
    document.getElementById('kpi-purchase-label').textContent = dashMonth + '月进货额';
    document.getElementById('kpi-supplies-label').textContent = dashMonth + '月辅料支出';

    document.getElementById('kpi-revenue').textContent = '¥' + fmt(report.totalRevenue);
    document.getElementById('kpi-sold-qty').textContent = report.totalSoldQty + ' 件已售';

    const profitEl = document.getElementById('kpi-profit');
    profitEl.textContent = '¥' + fmt(report.grossProfit);
    profitEl.className = 'kpi-value ' + (report.grossProfit >= 0 ? 'success' : 'danger');
    document.getElementById('kpi-profit-rate').textContent = '利润率 ' + report.profitRate + '%';

    document.getElementById('kpi-purchase').textContent = '¥' + fmt(report.totalPurchaseSpend);
    document.getElementById('kpi-purchase-qty').textContent = report.purchaseCount + ' 笔';

    document.getElementById('kpi-supplies').textContent = '¥' + fmt(report.totalSupplies);
    document.getElementById('kpi-supplies-qty').textContent = report.suppliesCount + ' 笔';

    const inv = getInventorySummary();
    document.getElementById('dash-stock-count').textContent = inv.reduce((s, i) => s + i.stock, 0);
    document.getElementById('dash-stock-value').textContent = '¥' + fmt(inv.reduce((s, i) => s + i.stockValue, 0));
    const designSet = new Set(inv.filter(i => i.design).map(i => i.design));
    document.getElementById('dash-model-count').textContent = designSet.size || inv.length;

    const recentEl = document.getElementById('recent-list');
    const sl = getSales().slice(0, 5).map(s => ({ icon: '💰', title: `${s.platform} · ${s.design ? s.design + ' ' : ''}${s.model} ×${s.quantity}`, date: s.date, amount: '+¥' + fmt(s.totalRevenue), cls: 'success', time: s.createdAt }));
    const pl = getPurchases().slice(0, 5).map(p => ({ icon: '📦', title: `${p.factory} · ${p.design} ${p.model} ×${p.quantity}`, date: p.date, amount: '-¥' + fmt(p.totalCost), cls: 'danger', time: p.createdAt }));
    const rl = getReturns().slice(0, 3).map(r => ({ icon: '↩️', title: `退货 · ${r.design ? r.design + ' ' : ''}${r.model} ×${r.quantity}`, date: r.date, amount: '-¥' + fmt(r.refundAmount), cls: 'warning', time: r.createdAt }));
    const items = [...sl, ...pl, ...rl].sort((a, b) => b.time - a.time).slice(0, 8);

    if (!items.length) recentEl.innerHTML = '<div class="empty-state">📝 还没有记录，快去记一笔吧～</div>';
    else recentEl.innerHTML = items.map(i => `<div class="recent-item"><div class="recent-left"><span class="recent-icon">${i.icon}</span><div class="recent-info"><span class="recent-title">${i.title}</span><span class="recent-date">${i.date}</span></div></div><span class="recent-amount ${i.cls}">${i.amount}</span></div>`).join('');
}

function changeDashMonth(delta) {
    dashMonth += delta;
    if (dashMonth < 1) { dashMonth = 12; dashYear--; }
    else if (dashMonth > 12) { dashMonth = 1; dashYear++; }
    renderDashboard();
}


// ============================================
// 进货页
// ============================================

function renderPurchases() {
    const purchases = getPurchases(), factories = getFactories(), designs = getDesigns();
    const fSummary = getFactorySummary();

    document.getElementById('factory-bar').innerHTML = fSummary.map(f => `<div class="factory-tag"><span class="factory-tag-name">${f.factory}</span><span class="factory-tag-amount">¥${fmt(f.totalAmount)}</span><span class="factory-tag-count">${f.orders}笔 / ${f.totalQty}件</span></div>`).join('');
    document.getElementById('purchase-count').textContent = '共' + purchases.length + '条';

    renderPurchaseList(purchases);
}

function renderPurchaseList(list) {
    const el = document.getElementById('purchase-list');
    if (!list.length) { el.innerHTML = '<div class="empty-state">📦 还没有进货记录</div>'; return; }
    el.innerHTML = list.map(p => `<div class="list-item"><div class="item-top"><div class="item-top-left"><span class="badge badge-blue">${p.factory}</span><span class="badge badge-purple">${p.design}</span><span class="item-model">${p.model}</span></div><button class="item-delete" onclick="confirmDeletePurchase('${p.id}')">✕</button></div><div class="item-stats"><div class="item-stat"><span class="item-stat-label">数量</span><span class="item-stat-value">${p.quantity}件</span></div></div><div class="item-bottom"><span>${p.date}</span>${p.note ? `<span>${p.note}</span>` : ''}</div></div>`).join('');
}

function submitPurchase() {
    const factory = document.getElementById('p-factory').value.trim();
    const design = document.getElementById('p-design').value;
    const model = document.getElementById('p-model').value;
    const quantity = document.getElementById('p-quantity').value;
    if (!factory || !design || !model || !quantity) { showToast('请填写完整信息', true); return; }
    addPurchase({ date: document.getElementById('p-date').value, factory, design, model, quantity, note: document.getElementById('p-note').value });
    showToast('进货记录已保存 ✓ 云端同步中');
    ['p-factory', 'p-design', 'p-model', 'p-quantity', 'p-note'].forEach(id => document.getElementById(id).value = '');
    toggleForm('purchase');
    refreshAll();
}

function confirmDeletePurchase(id) { showModal('确认删除', '确定要删除这条进货记录吗？', () => { deletePurchase(id); showToast('已删除'); refreshAll(); }); }


// ============================================
// 订货转账
// ============================================

let orderYear = new Date().getFullYear();
let orderMonth = new Date().getMonth() + 1;

function renderOrders() {
    const allOrders = getStore(KEYS.ORDERS);
    const yPrefix = String(orderYear);
    const orders = allOrders.filter(o => o.date && o.date.startsWith(yPrefix));
    const ym = orderYear + '-' + String(orderMonth).padStart(2, '0');
    const monthOrders = allOrders.filter(o => o.date && o.date.startsWith(ym));
    document.getElementById('order-month-total').textContent = '¥' + fmt(monthOrders.reduce((s, o) => s + o.amount, 0));
    document.getElementById('order-month-label').textContent = orderMonth + '月转账';
    document.getElementById('order-all-total').textContent = '¥' + fmt(orders.reduce((s, o) => s + o.amount, 0));
    document.getElementById('order-year-label').textContent = orderYear + '年';
    document.getElementById('order-year-title').textContent = orderYear + '年总转账';
    document.getElementById('order-count').textContent = '共' + orders.length + '条';

    const dateEl = document.getElementById('ord-date');
    if (dateEl && !dateEl.value) dateEl.value = getToday();



    const el = document.getElementById('order-list');
    if (!orders.length) { el.innerHTML = '<div class="empty-state">💳 ' + orderYear + '年还没有转账记录</div>'; return; }
    el.innerHTML = orders.map(o => `<div class="list-item"><div class="item-top"><div class="item-top-left"><span class="badge badge-blue">${o.factory}</span>${o.product ? `<span class="badge badge-purple">${o.product}</span>` : ''}</div><button class="item-delete" onclick="confirmDeleteOrder('${o.id}')">✕</button></div><div class="item-stats"><div class="item-stat"><span class="item-stat-label">转账金额</span><span class="item-stat-value danger">¥${fmt(o.amount)}</span></div></div><div class="item-bottom"><span>${o.date}</span>${o.note ? `<span>${o.note}</span>` : ''}</div></div>`).join('');
}

function changeOrderYear(delta) {
    orderYear += delta;
    renderOrders();
}

function changeOrderMonth(delta) {
    orderMonth += delta;
    if (orderMonth < 1) { orderMonth = 12; orderYear--; }
    else if (orderMonth > 12) { orderMonth = 1; orderYear++; }
    renderOrders();
}

function submitOrder() {
    const amount = parseFloat(document.getElementById('ord-amount').value);
    const factory = document.getElementById('ord-factory').value.trim();
    if (!amount || amount <= 0 || !factory) { showToast('请填写工厂名和金额', true); return; }
    const orders = getStore(KEYS.ORDERS);
    orders.unshift({
        id: genId(),
        date: document.getElementById('ord-date').value || getToday(),
        factory: factory,
        amount: amount,
        product: document.getElementById('ord-product').value.trim(),
        note: document.getElementById('ord-note').value.trim()
    });
    setStore(KEYS.ORDERS, orders);
    saveToList(KEYS.FACTORIES, factory);
    document.getElementById('ord-amount').value = '';
    document.getElementById('ord-factory').value = '';
    document.getElementById('ord-product').value = '';
    document.getElementById('ord-note').value = '';
    showToast('转账记录已保存 ✓');
    toggleForm('order');
    refreshAll();
}

function confirmDeleteOrder(id) {
    showModal('确认删除', '确定要删除这条转账记录吗？', () => {
        const orders = getStore(KEYS.ORDERS).filter(o => o.id !== id);
        setStore(KEYS.ORDERS, orders);
        showToast('已删除');
        refreshAll();
    });
}


// ============================================
// 辅料采购
// ============================================

let suppliesYear = new Date().getFullYear();
let suppliesMonth = new Date().getMonth() + 1;

function renderSupplies() {
    const allSupplies = getSupplies(), cats = getSupplyCats();
    const yPrefix = String(suppliesYear);
    const supplies = allSupplies.filter(s => s.date && s.date.startsWith(yPrefix));
    const prefix = suppliesYear + '-' + String(suppliesMonth).padStart(2, '0');
    const monthTotal = allSupplies.filter(s => s.date && s.date.startsWith(prefix)).reduce((sum, s) => sum + s.amount, 0);
    const yearTotal = supplies.reduce((sum, s) => sum + s.amount, 0);

    document.getElementById('supplies-month-total').textContent = '¥' + fmt(monthTotal);
    document.getElementById('supplies-month-label').textContent = suppliesMonth + '月辅料支出';
    document.getElementById('supplies-all-total').textContent = '¥' + fmt(yearTotal);
    document.getElementById('supplies-year-label').textContent = suppliesYear + '年';
    document.getElementById('supplies-year-title').textContent = suppliesYear + '年辅料支出';
    document.getElementById('supplies-count').textContent = '共' + supplies.length + '条';

    renderSuppliesList(supplies);

    function renderSuppliesList(list) {
        const el = document.getElementById('supplies-list');
        if (!list.length) { el.innerHTML = '<div class="empty-state">🎁 还没有辅料采购记录</div>'; return; }
        el.innerHTML = list.map(s => `<div class="list-item"><div class="item-top"><div class="item-top-left"><span class="badge badge-purple">${s.category}</span><span class="item-model">${s.name}</span></div><button class="item-delete" onclick="confirmDeleteSupply('${s.id}')">✕</button></div><div class="item-stats"><div class="item-stat"><span class="item-stat-label">数量</span><span class="item-stat-value">${s.quantity}</span></div><div class="item-stat"><span class="item-stat-label">金额</span><span class="item-stat-value danger">¥${fmt(s.amount)}</span></div></div><div class="item-bottom"><span>${s.date}</span>${s.note ? `<span>${s.note}</span>` : ''}</div></div>`).join('');
    }
    renderSuppliesList(supplies);

    // 设置快速记账日期默认值
    const qeDateEl = document.getElementById('qe-date');
    if (qeDateEl && !qeDateEl.value) qeDateEl.value = getToday();
}

function changeSuppliesYear(delta) {
    suppliesYear += delta;
    renderSupplies();
    updateExpenseBreakdown();
}

function changeSuppliesMonth(delta) {
    suppliesMonth += delta;
    if (suppliesMonth < 1) { suppliesMonth = 12; suppliesYear--; }
    else if (suppliesMonth > 12) { suppliesMonth = 1; suppliesYear++; }
    renderSupplies();
    updateExpenseBreakdown();
}

function submitSupply() {
    const category = document.getElementById('sup-category').value;
    const name = document.getElementById('sup-name').value;
    const quantity = document.getElementById('sup-quantity').value;
    const amount = document.getElementById('sup-amount').value;
    if (!category || !name || !amount) { showToast('请填写完整信息', true); return; }
    addSupply({ date: document.getElementById('sup-date').value, category, name, quantity: quantity || 1, amount, note: document.getElementById('sup-note').value });
    showToast('辅料记录已保存 ✓ 云端同步中');
    ['sup-category', 'sup-name', 'sup-quantity', 'sup-amount', 'sup-note'].forEach(id => document.getElementById(id).value = '');
    toggleForm('supplies');
    refreshAll();
}

function confirmDeleteSupply(id) { showModal('确认删除', '确定要删除这条辅料记录吗？', () => { deleteSupply(id); showToast('已删除'); refreshAll(); }); }

// --- 快速录入 ---
function getQeDate() {
    return document.getElementById('qe-date').value || getToday();
}

function quickCashback() {
    const qty = parseInt(document.getElementById('qe-cashback-qty').value) || 1;
    const amount = qty * 2;
    const supplies = getStore(KEYS.SUPPLIES);
    supplies.unshift({
        id: genId(), date: getQeDate(), category: '好评返现',
        name: `好评返现 ${qty}笔`, quantity: qty, amount: amount, note: ''
    });
    setStore(KEYS.SUPPLIES, supplies);
    document.getElementById('qe-cashback-qty').value = '1';
    showToast(`已记录好评返现 ${qty}笔 ¥${amount}`);
    refreshAll();
}

function quickExpress() {
    const amount = parseFloat(document.getElementById('qe-express-amount').value);
    if (!amount || amount <= 0) { showToast('请输入金额'); return; }
    const note = document.getElementById('qe-express-note').value.trim();
    const supplies = getStore(KEYS.SUPPLIES);
    supplies.unshift({
        id: genId(), date: getQeDate(), category: '快递费',
        name: '快递费', quantity: 1, amount: amount, note: note
    });
    setStore(KEYS.SUPPLIES, supplies);
    document.getElementById('qe-express-amount').value = '';
    document.getElementById('qe-express-note').value = '';
    showToast(`已记录快递费 ¥${fmt(amount)}`);
    refreshAll();
}

function quickSample() {
    const amount = parseFloat(document.getElementById('qe-sample-amount').value);
    if (!amount || amount <= 0) { showToast('请输入金额'); return; }
    const note = document.getElementById('qe-sample-note').value.trim();
    const supplies = getStore(KEYS.SUPPLIES);
    supplies.unshift({
        id: genId(), date: getQeDate(), category: '打样费用',
        name: '打样费用', quantity: 1, amount: amount, note: note
    });
    setStore(KEYS.SUPPLIES, supplies);
    document.getElementById('qe-sample-amount').value = '';
    document.getElementById('qe-sample-note').value = '';
    showToast(`已记录打样费用 ¥${fmt(amount)}`);
    refreshAll();
}

// ============================================
// 生活消费
// ============================================

function quickLife() {
    const amount = parseFloat(document.getElementById('qe-life-amount').value);
    if (!amount || amount <= 0) { showToast('请输入金额'); return; }
    const note = document.getElementById('qe-life-note').value.trim();
    const supplies = getStore(KEYS.SUPPLIES);
    supplies.unshift({
        id: genId(), date: getQeDate(), category: '生活消费',
        name: '生活消费', quantity: 1, amount: amount, note: note
    });
    setStore(KEYS.SUPPLIES, supplies);
    document.getElementById('qe-life-amount').value = '';
    document.getElementById('qe-life-note').value = '';
    showToast(`已记录生活消费 ¥${fmt(amount)}`);
    refreshAll();
}


// ============================================
// 支出分项统计
// ============================================

function updateExpenseBreakdown() {
    const yPrefix = String(suppliesYear);
    const supplies = getStore(KEYS.SUPPLIES).filter(s => s.date && s.date.startsWith(yPrefix));
    const cats = { '好评返现': 0, '快递费': 0, '打样费用': 0, '生活消费': 0 };
    supplies.forEach(s => { if (cats[s.category] !== undefined) cats[s.category] += s.amount; });
    document.getElementById('eb-cashback').textContent = '¥' + fmt(cats['好评返现']);
    document.getElementById('eb-express').textContent = '¥' + fmt(cats['快递费']);
    document.getElementById('eb-sample').textContent = '¥' + fmt(cats['打样费用']);
    document.getElementById('eb-life').textContent = '¥' + fmt(cats['生活消费']);
}


// ============================================
// 型号自动补全
// ============================================

const MODEL_PRESETS = {
    'i': [
        'iPhone 14', 'iPhone 14 Plus', 'iPhone 14 Pro', 'iPhone 14 Pro Max',
        'iPhone 15', 'iPhone 15 Plus', 'iPhone 15 Pro', 'iPhone 15 Pro Max',
        'iPhone 16', 'iPhone 16 Plus', 'iPhone 16 Pro', 'iPhone 16 Pro Max',
        'iPhone 17', 'iPhone 17 Plus', 'iPhone 17 Pro', 'iPhone 17 Pro Max'
    ],
    'h': [
        'HUAWEI Mate60', 'HUAWEI Mate60 Pro',
        'HUAWEI Mate70', 'HUAWEI Mate70 Pro',
        'HUAWEI P70', 'HUAWEI P70 Pro',
        'HUAWEI P80', 'HUAWEI P80 Pro'
    ],
    'x': [
        'XIAOMI 15 Pro'
    ]
};

function setupModelAutocomplete(inputId, listId) {
    const input = document.getElementById(inputId);
    const list = document.getElementById(listId);
    if (!input || !list) return;

    input.addEventListener('input', function () {
        const val = this.value.toLowerCase().trim();
        list.innerHTML = '';
        list.classList.remove('show');
        if (!val) return;

        let matches = [];
        // 按首字母匹配预设
        Object.keys(MODEL_PRESETS).forEach(prefix => {
            if (val.startsWith(prefix)) {
                const keyword = val.slice(prefix.length).toLowerCase();
                MODEL_PRESETS[prefix].forEach(model => {
                    if (!keyword || model.toLowerCase().includes(keyword)) {
                        matches.push(model);
                    }
                });
            }
        });

        if (matches.length === 0) return;
        matches.forEach(model => {
            const div = document.createElement('div');
            div.className = 'autocomplete-item';
            div.textContent = model;
            div.addEventListener('click', () => {
                input.value = model;
                list.classList.remove('show');
            });
            list.appendChild(div);
        });
        list.classList.add('show');
    });

    // 点击外部关闭
    document.addEventListener('click', e => {
        if (!input.contains(e.target) && !list.contains(e.target)) {
            list.classList.remove('show');
        }
    });
}


// ============================================
// 销售页
// ============================================

let salesYear = new Date().getFullYear();
let salesMonth = new Date().getMonth() + 1;

function renderSalesPage() {
    const report = getMonthlyReport(salesYear, salesMonth);
    document.getElementById('sales-month-revenue').textContent = '¥' + fmt(report.totalRevenue);
    document.getElementById('sales-month-label').textContent = salesMonth + '月销售';
    document.getElementById('sales-month-profit-label').textContent = salesMonth + '月利润';
    const profitEl = document.getElementById('sales-month-profit');
    profitEl.textContent = '¥' + fmt(report.grossProfit);
    profitEl.className = 'summary-value ' + (report.grossProfit >= 0 ? 'success' : 'danger');

    // 年度数据
    document.getElementById('sales-year-label').textContent = salesYear + '年';
    document.getElementById('sales-year-rev-title').textContent = salesYear + '年销售';
    document.getElementById('sales-year-profit-title').textContent = salesYear + '年利润';
    const yr = getYearlyReport(salesYear);
    document.getElementById('sales-year-revenue').textContent = '¥' + fmt(yr.totalRevenue);
    const yrProfitEl = document.getElementById('sales-year-profit');
    yrProfitEl.textContent = '¥' + fmt(yr.grossProfit);
    yrProfitEl.className = 'summary-value ' + (yr.grossProfit >= 0 ? 'success' : 'danger');

    document.getElementById('sales-count').textContent = '共' + getSales().length + '条';
    const filtered = salesFilter ? getSales().filter(s => s.platform === salesFilter) : getSales();
    renderSalesList(filtered);
}

function changeSalesYear(delta) {
    salesYear += delta;
    renderSalesPage();
}

function changeSalesMonth(delta) {
    salesMonth += delta;
    if (salesMonth < 1) { salesMonth = 12; salesYear--; }
    else if (salesMonth > 12) { salesMonth = 1; salesYear++; }
    renderSalesPage();
}

function filterSales(platform) {
    salesFilter = platform;
    document.querySelectorAll('#sales-filters .filter-chip').forEach(el => el.classList.toggle('active', el.textContent === (platform || '全部')));
    renderSalesList(platform ? getSales().filter(s => s.platform === platform) : getSales());
}

function renderSalesList(list) {
    const el = document.getElementById('sales-list');
    if (!list.length) { el.innerHTML = '<div class="empty-state">💰 还没有销售记录</div>'; return; }
    el.innerHTML = list.map(s => `<div class="list-item"><div class="item-top"><div class="item-top-left"><span class="badge ${s.platform === '淘宝' ? 'badge-orange' : s.platform === '抖音' ? 'badge-douyin' : 'badge-xhs'}">${s.platform}</span>${s.design ? `<span class="badge badge-purple">${s.design}</span>` : ''}<span class="item-model">${s.model}</span></div><button class="item-delete" onclick="confirmDeleteSale('${s.id}')">✕</button></div><div class="item-stats"><div class="item-stat"><span class="item-stat-label">数量</span><span class="item-stat-value">${s.quantity}件</span></div><div class="item-stat"><span class="item-stat-label">售价</span><span class="item-stat-value">¥${s.sellingPrice}/件</span></div><div class="item-stat"><span class="item-stat-label">收入</span><span class="item-stat-value success">¥${fmt(s.totalRevenue)}</span></div><div class="item-stat"><span class="item-stat-label">利润</span><span class="item-stat-value ${s.profit >= 0 ? 'success' : 'danger'}">¥${fmt(s.profit)}</span></div></div><div class="item-bottom"><span>${s.date}</span><span>成本：进货${s.purchaseCost}+物流${s.logistics}+包装${s.packaging}+险${s.insurance}</span></div></div>`).join('');
}

function submitSale() {
    const model = document.getElementById('s-model').value;
    const quantity = document.getElementById('s-quantity').value;
    const price = document.getElementById('s-price').value;
    const cost = document.getElementById('s-cost').value;
    if (!model || !quantity || !price || !cost) { showToast('请填写完整信息', true); return; }
    const commissionVal = document.querySelector('input[name="s-commission"]:checked')?.value || '0';
    addSale({ date: document.getElementById('s-date').value, platform: currentPlatform, design: document.getElementById('s-design').value, model, quantity, sellingPrice: price, purchaseCost: cost, logistics: document.getElementById('s-logistics').value || 4, packaging: document.getElementById('s-packaging').value || 3, insurance: document.getElementById('s-insurance').value || 1.5, commission: commissionVal, note: document.getElementById('s-note').value });
    showToast('销售记录已保存 ✓ 云端同步中');
    ['s-design', 's-model', 's-price', 's-cost', 's-note'].forEach(id => document.getElementById(id).value = '');
    document.getElementById('s-quantity').value = '1';
    document.querySelector('input[name="s-commission"][value="0"]').checked = true;
    document.getElementById('s-profit-preview').style.display = 'none';
    toggleForm('sales');
    refreshAll();
}

function confirmDeleteSale(id) { showModal('确认删除', '确定要删除这条销售记录吗？', () => { deleteSale(id); showToast('已删除'); refreshAll(); }); }


// ============================================
// 退货页
// ============================================

let returnsYear = new Date().getFullYear();
let returnsMonth = new Date().getMonth() + 1;

function renderReturns() {
    const allReturns = getReturns();
    const ym = returnsYear + '-' + String(returnsMonth).padStart(2, '0');
    const mr = allReturns.filter(r => r.date && r.date.startsWith(ym));
    const yPrefix = String(returnsYear);
    const yr = allReturns.filter(r => r.date && r.date.startsWith(yPrefix));
    document.getElementById('returns-month-count').textContent = mr.reduce((s, r) => s + r.quantity, 0) + '件';
    document.getElementById('returns-month-amount').textContent = '¥' + fmt(mr.reduce((s, r) => s + r.refundAmount, 0));
    document.getElementById('returns-month-label').textContent = returnsMonth + '月退货';
    document.getElementById('returns-amount-label').textContent = returnsMonth + '月退款';
    document.getElementById('returns-year-label').textContent = returnsYear + '年';
    document.getElementById('returns-year-title').textContent = returnsYear + '年退款';
    document.getElementById('returns-year-amount').textContent = '¥' + fmt(yr.reduce((s, r) => s + r.refundAmount, 0));
    document.getElementById('returns-count').textContent = '共' + allReturns.length + '条';

    const el = document.getElementById('returns-list');
    if (!allReturns.length) { el.innerHTML = '<div class="empty-state">↩️ 还没有退货记录</div>'; return; }
    el.innerHTML = allReturns.map(r => `<div class="list-item"><div class="item-top"><div class="item-top-left"><span class="badge ${r.platform === '淘宝' ? 'badge-orange' : r.platform === '抖音' ? 'badge-douyin' : 'badge-xhs'}">${r.platform}</span>${r.design ? `<span class="badge badge-purple">${r.design}</span>` : ''}<span class="item-model">${r.model}</span></div><button class="item-delete" onclick="confirmDeleteReturn('${r.id}')">✕</button></div><div class="item-stats"><div class="item-stat"><span class="item-stat-label">退货数量</span><span class="item-stat-value">${r.quantity}件</span></div><div class="item-stat"><span class="item-stat-label">退款金额</span><span class="item-stat-value danger">¥${fmt(r.refundAmount)}</span></div></div><div class="item-bottom"><span>${r.date}</span>${r.reason ? `<span>原因：${r.reason}</span>` : ''}</div></div>`).join('');
}

function changeReturnsYear(delta) {
    returnsYear += delta;
    renderReturns();
}

function changeReturnsMonth(delta) {
    returnsMonth += delta;
    if (returnsMonth < 1) { returnsMonth = 12; returnsYear--; }
    else if (returnsMonth > 12) { returnsMonth = 1; returnsYear++; }
    renderReturns();
}

function submitReturn() {
    const model = document.getElementById('r-model').value;
    const quantity = document.getElementById('r-quantity').value;
    const refund = document.getElementById('r-refund').value;
    if (!model || !quantity || !refund) { showToast('请填写完整信息', true); return; }
    addReturn({ date: document.getElementById('r-date').value, platform: returnPlatform, design: document.getElementById('r-design').value, model, quantity, refundAmount: refund, reason: document.getElementById('r-reason').value });
    showToast('退货已记录，库存已回补 ✓');
    ['r-design', 'r-model', 'r-reason'].forEach(id => document.getElementById(id).value = '');
    document.getElementById('r-quantity').value = '1';
    document.getElementById('r-refund').value = '';
    toggleForm('returns');
    refreshAll();
}

function confirmDeleteReturn(id) { showModal('确认删除', '确定删除退货记录吗？库存也会调整。', () => { deleteReturn(id); showToast('已删除'); refreshAll(); }); }


// ============================================
// 推广费用页
// ============================================

let promoYear = new Date().getFullYear();
let promoMonth = new Date().getMonth() + 1;

function renderPromotion() {
    const allPromos = getStore(KEYS.PROMOTIONS);
    const ym = promoYear + '-' + String(promoMonth).padStart(2, '0');
    const monthPromos = allPromos.filter(p => p.date && p.date.startsWith(ym));
    const yPrefix = String(promoYear);
    const yearPromos = allPromos.filter(p => p.date && p.date.startsWith(yPrefix));
    document.getElementById('promo-month-total').textContent = '¥' + fmt(monthPromos.reduce((s, p) => s + p.amount, 0));
    document.getElementById('promo-month-label').textContent = promoMonth + '月推广支出';
    document.getElementById('promo-all-total').textContent = '¥' + fmt(yearPromos.reduce((s, p) => s + p.amount, 0));
    document.getElementById('promo-year-label').textContent = promoYear + '年';
    document.getElementById('promo-year-title').textContent = promoYear + '年推广支出';
    document.getElementById('promo-count').textContent = '共' + allPromos.length + '条';

    // 设置日期默认值
    const dateEl = document.getElementById('promo-date');
    if (dateEl && !dateEl.value) dateEl.value = getToday();

    const el = document.getElementById('promo-list');
    if (!allPromos.length) { el.innerHTML = '<div class="empty-state">📣 还没有推广记录</div>'; return; }
    el.innerHTML = allPromos.map(p => `<div class="list-item"><div class="item-top"><div class="item-top-left"><span class="badge ${p.type === '博主推广' ? 'badge-purple' : 'badge-orange'}">${p.type}</span></div><button class="item-delete" onclick="confirmDeletePromo('${p.id}')">✕</button></div><div class="item-stats"><div class="item-stat"><span class="item-stat-label">金额</span><span class="item-stat-value danger">¥${fmt(p.amount)}</span></div></div><div class="item-bottom"><span>${p.date}</span>${p.note ? `<span>${p.note}</span>` : ''}</div></div>`).join('');
}

function changePromoYear(delta) {
    promoYear += delta;
    renderPromotion();
}

function changePromoMonth(delta) {
    promoMonth += delta;
    if (promoMonth < 1) { promoMonth = 12; promoYear--; }
    else if (promoMonth > 12) { promoMonth = 1; promoYear++; }
    renderPromotion();
}

function submitPromotion() {
    const amount = parseFloat(document.getElementById('promo-amount').value);
    if (!amount || amount <= 0) { showToast('请输入金额', true); return; }
    const promos = getStore(KEYS.PROMOTIONS);
    promos.unshift({
        id: genId(),
        date: document.getElementById('promo-date').value || getToday(),
        amount: amount,
        type: document.getElementById('promo-type').value || '博主推广',
        note: document.getElementById('promo-note').value.trim()
    });
    setStore(KEYS.PROMOTIONS, promos);
    document.getElementById('promo-amount').value = '';
    document.getElementById('promo-note').value = '';
    showToast('推广记录已保存 ✓');
    toggleForm('promo');
    refreshAll();
}

function setPromoType(btn, type) {
    btn.parentElement.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('promo-type').value = type;
}

function confirmDeletePromo(id) {
    showModal('确认删除', '确定要删除这条推广记录吗？', () => {
        const promos = getStore(KEYS.PROMOTIONS).filter(p => p.id !== id);
        setStore(KEYS.PROMOTIONS, promos);
        showToast('已删除');
        refreshAll();
    });
}

// ============================================
// 库存页
// ============================================

function renderInventory() {
    const inventory = getInventorySummary();
    const search = (document.getElementById('inv-search')?.value || '').toLowerCase();
    const filtered = search ? inventory.filter(i => i.design.toLowerCase().includes(search) || i.model.toLowerCase().includes(search)) : inventory;

    const totalStock = inventory.reduce((s, i) => s + i.stock, 0);
    const totalValue = inventory.reduce((s, i) => s + i.stockValue, 0);
    const designSet = new Set(inventory.filter(i => i.design).map(i => i.design));

    document.getElementById('inv-total-stock').textContent = totalStock + '件';
    document.getElementById('inv-total-value').textContent = '¥' + fmt(totalValue);
    document.getElementById('inv-model-count').textContent = designSet.size + '款/' + inventory.length + '号';

    const el = document.getElementById('inventory-list');
    if (!filtered.length) { el.innerHTML = '<div class="empty-state">📋 ' + (search ? '没有找到匹配的款名或型号' : '暂无库存数据') + '</div>'; return; }

    if (invViewMode === 'design') {
        const groups = {};
        filtered.forEach(item => { const d = item.design || '未分类'; if (!groups[d]) groups[d] = []; groups[d].push(item); });
        el.innerHTML = Object.entries(groups).map(([design, items]) => {
            const gs = items.reduce((s, i) => s + i.stock, 0), gv = items.reduce((s, i) => s + i.stockValue, 0);
            const gp = items.reduce((s, i) => s + i.totalPurchased, 0), gsold = items.reduce((s, i) => s + i.totalSold, 0);
            const pct = gp > 0 ? Math.round(gsold / gp * 100) : 0;
            return `<div class="design-group"><div class="design-header" onclick="this.parentElement.classList.toggle('collapsed')"><div class="design-header-left"><span class="design-arrow">▼</span><span class="design-name">${design}</span><span class="badge badge-purple">${items.length}个型号</span></div><div class="design-header-right"><span class="design-stat">库存 ${gs}件</span><span class="design-stat danger">¥${fmt(gv)}</span><span class="design-pct">${pct}%已售</span></div></div><div class="design-body">${items.map(item => renderInvItem(item)).join('')}</div></div>`;
        }).join('');
    } else {
        el.innerHTML = filtered.map(item => renderInvItem(item)).join('');
    }
}

function renderInvItem(item) {
    const pct = item.totalPurchased > 0 ? Math.round(item.totalSold / item.totalPurchased * 100) : 0;
    return `<div class="inv-item"><div class="inv-header">${item.design ? `<span class="badge badge-purple" style="margin-right:6px">${item.design}</span>` : ''}<span class="inv-model">${item.model}</span><span class="inv-badge ${item.stock > 0 ? 'has-stock' : 'no-stock'}">${item.stock > 0 ? '库存' + item.stock + '件' : '已清零'}</span></div>${item.totalPurchased > 0 ? `<div class="progress"><div class="progress-fill" style="width:${pct}%"></div></div><div class="progress-labels"><span>已售 ${item.totalSold}/${item.totalPurchased}</span><span class="progress-pct">${pct}%</span></div>` : ''}<div class="inv-details"><div class="inv-detail"><span class="inv-detail-label">进货总量</span><span class="inv-detail-value">${item.totalPurchased}件</span></div><div class="inv-detail"><span class="inv-detail-label">已售出</span><span class="inv-detail-value success">${item.totalSold}件</span></div>${item.totalReturned > 0 ? `<div class="inv-detail"><span class="inv-detail-label">退货回库</span><span class="inv-detail-value warning">${item.totalReturned}件</span></div>` : ''}<div class="inv-detail"><span class="inv-detail-label">进货均价</span><span class="inv-detail-value">¥${item.avgCost}</span></div>${item.stock > 0 ? `<div class="inv-detail"><span class="inv-detail-label">积压成本</span><span class="inv-detail-value danger">¥${fmt(item.stockValue)}</span></div>` : ''}</div></div>`;
}


// ============================================
// 报表页
// ============================================

function renderReport() {
    document.getElementById('report-month').textContent = reportYear + '年' + reportMonth + '月';
    document.getElementById('rpt-year').textContent = reportYear;
    const report = getMonthlyReport(reportYear, reportMonth);

    const profitEl = document.getElementById('rpt-profit');
    profitEl.textContent = '¥' + fmt(report.grossProfit);
    profitEl.className = 'profit-big-num ' + (report.grossProfit >= 0 ? 'success' : 'danger');

    const rateBadge = document.getElementById('rpt-rate-badge');
    rateBadge.textContent = '利润率 ' + report.profitRate + '%';
    rateBadge.className = 'badge ' + (report.grossProfit >= 0 ? 'badge-green' : 'badge-orange');

    document.getElementById('rpt-revenue').textContent = '+¥' + fmt(report.totalRevenue);
    document.getElementById('rpt-cost').textContent = '-¥' + fmt(report.totalCost);

    if (report.totalRefund > 0) { document.getElementById('rpt-refund-row').style.display = 'flex'; document.getElementById('rpt-refund').textContent = '-¥' + fmt(report.totalRefund); }
    else { document.getElementById('rpt-refund-row').style.display = 'none'; }

    document.getElementById('rpt-supplies').textContent = '-¥' + fmt(report.totalSupplies);
    document.getElementById('rpt-promo').textContent = '-¥' + fmt(report.totalPromo);
    document.getElementById('rpt-orders').textContent = '-¥' + fmt(report.totalOrders);

    document.getElementById('rpt-sold-qty').textContent = report.totalSoldQty;
    document.getElementById('rpt-return-qty').textContent = report.totalReturnQty;
    document.getElementById('rpt-purchase-spend').textContent = '¥' + fmt(report.totalPurchaseSpend);

    const pbEl = document.getElementById('platform-breakdown');
    const pb = report.platformBreakdown, platforms = Object.keys(pb);
    if (!platforms.length) pbEl.innerHTML = '<div class="empty-state-sm">暂无数据</div>';
    else pbEl.innerHTML = platforms.map(name => { const d = pb[name]; return `<div class="platform-item"><div class="platform-header"><span class="badge ${name === '淘宝' ? 'badge-orange' : name === '抖音' ? 'badge-douyin' : 'badge-xhs'}">${name}</span><span class="platform-profit ${d.profit >= 0 ? 'success' : 'danger'}">利润 ¥${fmt(d.profit)}</span></div><div class="platform-stats"><span>收入 ¥${fmt(d.revenue)}</span><span>成本 ¥${fmt(d.cost)}</span><span>${d.qty}件</span></div></div>`; }).join('');

    const fsEl = document.getElementById('factory-summary');
    const fs = getFactorySummary(reportYear);
    if (!fs.length) fsEl.innerHTML = '<div class="empty-state-sm">暂无数据</div>';
    else { const total = fs.reduce((s, f) => s + f.totalAmount, 0); fsEl.innerHTML = fs.map(f => `<div class="factory-row"><div class="factory-info"><span class="factory-name">${f.factory}</span><span class="factory-meta">${f.orders}笔 · ${f.totalQty}件</span></div><span class="factory-amount danger">¥${fmt(f.totalAmount)}</span></div>`).join('') + `<div class="factory-total"><span class="factory-total-label">全年总计</span><span class="factory-total-value danger">¥${fmt(total)}</span></div>`; }

    renderTrendChart();

    // 年度汇总
    const yr = getYearlyReport(reportYear);
    document.getElementById('yr-year-label').textContent = reportYear;
    const yrProfitEl = document.getElementById('yr-profit');
    yrProfitEl.textContent = '¥' + fmt(yr.grossProfit);
    yrProfitEl.className = 'profit-big-num ' + (yr.grossProfit >= 0 ? 'success' : 'danger');
    const yrBadge = document.getElementById('yr-rate-badge');
    yrBadge.textContent = '利润率 ' + yr.profitRate + '%';
    yrBadge.className = 'badge ' + (yr.grossProfit >= 0 ? 'badge-green' : 'badge-orange');
    document.getElementById('yr-revenue').textContent = '+¥' + fmt(yr.totalRevenue);
    document.getElementById('yr-cost').textContent = '-¥' + fmt(yr.totalCost);
    if (yr.totalRefund > 0) { document.getElementById('yr-refund-row').style.display = 'flex'; document.getElementById('yr-refund').textContent = '-¥' + fmt(yr.totalRefund); }
    else { document.getElementById('yr-refund-row').style.display = 'none'; }
    document.getElementById('yr-supplies').textContent = '-¥' + fmt(yr.totalSupplies);
    document.getElementById('yr-promo').textContent = '-¥' + fmt(yr.totalPromo);
    document.getElementById('yr-orders').textContent = '-¥' + fmt(yr.totalOrders);
    document.getElementById('yr-sold-qty').textContent = yr.totalSoldQty;
    document.getElementById('yr-return-qty').textContent = yr.totalReturnQty;
    document.getElementById('yr-purchase-spend').textContent = '¥' + fmt(yr.totalPurchaseSpend);
}

function getYearlyReport(year) {
    const yPrefix = String(year);
    const ys = getSales().filter(s => s.date.startsWith(yPrefix));
    const yp = getPurchases().filter(p => p.date.startsWith(yPrefix));
    const yr = getReturns().filter(r => r.date.startsWith(yPrefix));
    const ysup = getSupplies().filter(s => s.date.startsWith(yPrefix));
    const ypromo = getStore(KEYS.PROMOTIONS).filter(p => p.date && p.date.startsWith(yPrefix));
    const yorders = getStore(KEYS.ORDERS).filter(o => o.date && o.date.startsWith(yPrefix));

    const totalRevenue = ys.reduce((s, x) => s + x.totalRevenue, 0);
    const totalCost = ys.reduce((s, x) => s + x.totalCost, 0);
    const totalRefund = yr.reduce((s, x) => s + (x.refundAmount || 0), 0);
    const totalSupplies = ysup.reduce((s, x) => s + x.amount, 0);
    const totalPromo = ypromo.reduce((s, x) => s + x.amount, 0);
    const totalOrders = yorders.reduce((s, x) => s + x.amount, 0);
    const grossProfit = totalRevenue - totalCost - totalRefund - totalSupplies - totalPromo - totalOrders;

    return {
        totalRevenue: Math.round(totalRevenue * 100) / 100,
        totalCost: Math.round(totalCost * 100) / 100,
        totalRefund: Math.round(totalRefund * 100) / 100,
        totalSupplies: Math.round(totalSupplies * 100) / 100,
        totalPromo: Math.round(totalPromo * 100) / 100,
        totalOrders: Math.round(totalOrders * 100) / 100,
        grossProfit: Math.round(grossProfit * 100) / 100,
        totalSoldQty: ys.reduce((s, x) => s + x.quantity, 0),
        totalReturnQty: yr.reduce((s, x) => s + x.quantity, 0),
        totalPurchaseSpend: Math.round(yp.reduce((s, x) => s + x.totalCost, 0) * 100) / 100,
        profitRate: totalRevenue > 0 ? Math.round(grossProfit / totalRevenue * 10000) / 100 : 0
    };
}

function changeMonth(delta) {
    reportMonth += delta;
    if (reportMonth > 12) { reportMonth = 1; reportYear++; }
    if (reportMonth < 1) { reportMonth = 12; reportYear--; }
    renderReport();
}

function renderTrendChart() {
    const trend = getMonthlyTrend();
    const maxVal = Math.max(...trend.map(t => Math.max(t.revenue, Math.abs(t.profit))), 1);
    document.getElementById('trend-chart').innerHTML = trend.map(t => {
        const rh = Math.max(4, Math.round((t.revenue / maxVal) * 120));
        const ph = Math.max(4, Math.round((Math.abs(t.profit) / maxVal) * 120));
        const rLabel = t.revenue > 0 ? `¥${fmt(t.revenue)}` : '';
        const pLabel = t.profit !== 0 ? `¥${fmt(t.profit)}` : '';
        return `<div class="chart-group"><div class="chart-bar-pair"><div class="chart-bar-wrap"><span class="bar-value">${rLabel}</span><div class="chart-bar revenue" style="height:${rh}px"></div></div><div class="chart-bar-wrap"><span class="bar-value">${pLabel}</span><div class="chart-bar profit" style="height:${ph}px"></div></div></div><span class="chart-label">${t.label}</span></div>`;
    }).join('');
}


// ============================================
// 导出 / 备份 / 恢复
// ============================================

function exportData() {
    const blob = new Blob([generateCSV()], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = '壳记账_数据导出_' + getToday() + '.csv';
    document.body.appendChild(link); link.click(); document.body.removeChild(link);
    showToast('导出成功 ✓');
}

function backupData() {
    const backup = {
        version: '3.0', exportDate: new Date().toISOString(), app: '壳记账', data: {
            purchases: getPurchases(), sales: getSales(), returns: getReturns(), supplies: getSupplies(),
            factories: getFactories(), designs: getDesigns(), supplyCats: getSupplyCats()
        }
    };
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = '壳记账_备份_' + getToday() + '.json';
    document.body.appendChild(link); link.click(); document.body.removeChild(link);
    showToast(`备份成功 ✓ ${backup.data.purchases.length}条进货 + ${backup.data.sales.length}条销售`);
}

function restoreData(input) {
    const file = input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function (e) {
        try {
            const backup = JSON.parse(e.target.result);
            if (!backup.data || !backup.data.purchases || !backup.data.sales) { showToast('文件格式不正确', true); input.value = ''; return; }
            const p = backup.data.purchases.length, s = backup.data.sales.length;
            const dateStr = backup.exportDate ? new Date(backup.exportDate).toLocaleDateString('zh-CN') : '未知';
            showModal('确认恢复数据', `将恢复：${p}条进货 + ${s}条销售（备份日期：${dateStr}）。当前数据会被覆盖，同时同步到云端。`, () => {
                setStore(KEYS.PURCHASES, backup.data.purchases || []);
                setStore(KEYS.SALES, backup.data.sales || []);
                setStore(KEYS.RETURNS, backup.data.returns || []);
                setStore(KEYS.SUPPLIES, backup.data.supplies || []);
                setStore(KEYS.FACTORIES, backup.data.factories || []);
                setStore(KEYS.DESIGNS, backup.data.designs || []);
                setStore(KEYS.SUPPLY_CATS, backup.data.supplyCats || []);
                showToast('恢复成功 ✓ 数据已同步到云端');
                refreshAll();
            });
        } catch { showToast('文件读取失败', true); }
        input.value = '';
    };
    reader.readAsText(file);
}
