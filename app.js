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
    SUPPLY_CATS: 'shell_supply_cats',
    SALARIES: 'shell_salaries',
    SHELL_COSTS: 'shell_ref_shells',
    BRACKET_COSTS: 'shell_ref_brackets'
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
        quantity: Number(item.quantity), unitCost: Number(item.unitCost) || 0, totalCost: Number(item.quantity) * (Number(item.unitCost) || 0),
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
    const qty = Number(item.quantity);
    const lo = Number(item.logistics) || 4;
    const ins = Number(item.insurance) || 1.5;
    const lossPerUnit = lo + ins;
    const record = {
        id: genId(), date: item.date || getToday(), platform: item.platform,
        design: (item.design || '').trim(), model: (item.model || '').trim(),
        quantity: qty, logistics: lo, insurance: ins,
        refundAmount: lossPerUnit * qty,
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

    csv += '\n【订货转账】\n日期,工厂,商品,转账金额,备注\n';
    getStore(KEYS.ORDERS).forEach(o => { csv += `${o.date},${o.factory},${o.product || ''},${o.amount},${o.note || ''}\n`; });

    csv += '\n【推广费用】\n日期,类型,金额,备注\n';
    getStore(KEYS.PROMOTIONS).forEach(p => { csv += `${p.date},${p.type},${p.amount},${p.note || ''}\n`; });

    csv += '\n【库存汇总】\n款名,型号,进货总量,已售总量,退货总量,库存量,进货均价,积压成本\n';
    getInventorySummary().forEach(i => { csv += `${i.design},${i.model},${i.totalPurchased},${i.totalSold},${i.totalReturned},${i.stock},${i.avgCost},${i.stockValue}\n`; });

    return BOM + csv;
}


// ============================================
// 登录验证
// ============================================

// 哈希值（源码中不再暴露明文密码）
const AUTH_HASH = 'd87825c27f41c8fc2ab90f3d44960f53d12feaff2d5e7d4ae1958b8b3a5c523f';

async function sha256(text) {
    const data = new TextEncoder().encode(text);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function isLoggedIn() {
    return sessionStorage.getItem('shell_auth') === 'true';
}

async function doLogin() {
    const user = document.getElementById('login-user').value.trim();
    const pass = document.getElementById('login-pass').value.trim();
    const hash = await sha256(user + ':' + pass);
    if (hash === AUTH_HASH) {
        sessionStorage.setItem('shell_auth', 'true');
        document.getElementById('login-overlay').style.display = 'none';
        document.getElementById('sidebar').style.display = '';
        document.getElementById('mainContent').style.display = '';
        initApp();
    } else {
        document.getElementById('login-error').classList.add('show');
        const card = document.getElementById('login-card');
        card.classList.remove('shake');
        void card.offsetWidth;
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
    ['p-date', 's-date', 'r-date', 'sup-date', 'sal-date'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = today;
    });
    const now = new Date();
    reportYear = now.getFullYear();
    reportMonth = now.getMonth() + 1;
    bindFormListeners();
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
    if (typeof renderSalary === 'function') renderSalary();
    if (typeof renderCostRef === 'function') renderCostRef();
}

// --- 视图切换 ---
function switchView(view) {
    document.querySelectorAll('.nav-item').forEach(el => el.classList.toggle('active', el.dataset.view === view));
    document.querySelectorAll('.view').forEach(el => el.classList.toggle('active', el.id === 'view-' + view));
    const titles = { dashboard: '首页概览', purchase: '📦 进货记录', supplies: '🎁 辅料采购', sales: '💰 销售记录', returns: '↩️ 退货记录', inventory: '📋 库存管理', report: '📈 月度报表', salary: '💸 发工资', costref: '📝 成本参考' };
    document.getElementById('pageTitle').textContent = titles[view] || view;
    currentView = view;
    document.getElementById('sidebar').classList.remove('open');
    renderCurrentView();
}

function renderCurrentView() {
    switch (currentView) {
        case 'dashboard': renderDashboard(); updateExpenseBreakdown(); break;
        case 'purchase': renderPurchases(); break;
        case 'supplies': renderSupplies(); break;
        case 'sales': renderSalesPage(); break;
        case 'returns': renderReturns(); break;
        case 'inventory': renderInventory(); break;
        case 'report': renderReport(); break;
        case 'promotion': renderPromotion(); break;
        case 'orders': renderOrders(); break;
        case 'salary': renderSalary(); break;
        case 'costref': renderCostRef(); break;
    }
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

    // 可分配余额
    const allSales = getSales();
    const allReturns = getReturns();
    const allSupplies = getSupplies();
    const allPromos = getStore(KEYS.PROMOTIONS);
    const allOrders = getStore(KEYS.ORDERS);
    const allSalaries = getStore(KEYS.SALARIES);
    const totalProfitAll = allSales.reduce((s, x) => s + (x.profit || 0), 0)
        - allReturns.reduce((s, x) => s + (x.refundAmount || 0), 0)
        - allSupplies.reduce((s, x) => s + (x.amount || 0), 0)
        - allPromos.reduce((s, x) => s + (x.amount || 0), 0)
        - allOrders.reduce((s, x) => s + (x.amount || 0), 0);
    const totalPaid = allSalaries.reduce((s, x) => s + (x.amount || 0), 0);
    const balance = totalProfitAll - totalPaid;
    const balEl = document.getElementById('kpi-balance');
    balEl.textContent = '¥' + fmt(balance);
    balEl.className = 'kpi-value ' + (balance >= 0 ? 'success' : 'danger');

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
    el.innerHTML = `<div class="table-wrap"><table class="ref-table"><thead><tr><th>日期</th><th>工厂</th><th>款名</th><th>型号</th><th>数量</th><th>单价</th><th>总成本</th><th></th></tr></thead><tbody>` + list.map(p => `<tr><td>${p.date}</td><td>${p.factory}</td><td>${p.design}</td><td>${p.model}</td><td>${p.quantity}件</td><td>¥${fmt(p.unitCost || 0)}</td><td class="danger">¥${fmt(p.totalCost || 0)}</td><td class="td-delete" onclick="confirmDeletePurchase('${p.id}')">✕</td></tr>`).join('') + `</tbody></table></div>`;
}

function submitPurchase() {
    const factory = document.getElementById('p-factory').value.trim();
    const design = document.getElementById('p-design').value;
    const model = document.getElementById('p-model').value;
    const quantity = document.getElementById('p-quantity').value;
    const unitCost = document.getElementById('p-unitcost').value;
    if (!factory || !design || !model || !quantity || !unitCost) { showToast('请填写完整信息', true); return; }
    if (Number(quantity) <= 0) { showToast('数量必须大于0', true); return; }
    if (Number(unitCost) <= 0) { showToast('单价必须大于0', true); return; }
    addPurchase({ date: document.getElementById('p-date').value, factory, design, model, quantity, unitCost, note: document.getElementById('p-note').value });
    showToast('进货记录已保存 ✓ 云端同步中');
    ['p-factory', 'p-design', 'p-model', 'p-quantity', 'p-unitcost', 'p-note'].forEach(id => document.getElementById(id).value = '');
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
    el.innerHTML = `<div class="table-wrap"><table class="ref-table"><thead><tr><th>日期</th><th>工厂</th><th>商品</th><th>转账金额</th><th>备注</th><th></th></tr></thead><tbody>` + orders.map(o => `<tr><td>${o.date}</td><td>${o.factory}</td><td>${o.product || '-'}</td><td class="danger">¥${fmt(o.amount)}</td><td>${o.note || '-'}</td><td class="td-delete" onclick="confirmDeleteOrder('${o.id}')">✕</td></tr>`).join('') + `</tbody></table></div>`;
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
        el.innerHTML = `<div class="table-wrap"><table class="ref-table"><thead><tr><th>日期</th><th>分类</th><th>名称</th><th>数量</th><th>金额</th><th>备注</th><th></th></tr></thead><tbody>` + list.map(s => `<tr><td>${s.date}</td><td>${s.category}</td><td>${s.name}</td><td>${s.quantity}</td><td class="danger">¥${fmt(s.amount)}</td><td>${s.note || '-'}</td><td class="td-delete" onclick="confirmDeleteSupply('${s.id}')">✕</td></tr>`).join('') + `</tbody></table></div>`;
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

    // 填充库存商品下拉
    populateSaleProductDropdown();
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
    const pCls = (p) => p === '淘宝' ? 'badge-orange' : p === '抖音' ? 'badge-douyin' : 'badge-xhs';
    el.innerHTML = `<div class="table-wrap"><table class="ref-table"><thead><tr><th>日期</th><th>平台</th><th>款名</th><th>型号</th><th>数量</th><th>售价</th><th>收入</th><th>利润</th><th></th></tr></thead><tbody>` + list.map(s => `<tr><td>${s.date}</td><td><span class="badge ${pCls(s.platform)}">${s.platform}</span></td><td>${s.design || '-'}</td><td>${s.model}</td><td>${s.quantity}件</td><td>¥${s.sellingPrice}</td><td class="success">¥${fmt(s.totalRevenue)}</td><td class="${s.profit >= 0 ? 'success' : 'danger'}">¥${fmt(s.profit)}</td><td class="td-delete" onclick="confirmDeleteSale('${s.id}')">✕</td></tr>`).join('') + `</tbody></table></div>`;
}
// 库存商品查找表（design+model → unitCost）
let _productMap = {};

function populateSaleProductDropdown() {
    const purchases = getPurchases();
    _productMap = {};
    purchases.forEach(p => {
        const k = p.design + ' - ' + p.model;
        if (!_productMap[k]) _productMap[k] = { design: p.design, model: p.model, unitCost: p.unitCost || 0 };
    });
    const dl = document.getElementById('product-list');
    if (!dl) return;
    dl.innerHTML = Object.entries(_productMap)
        .map(([label, v]) => `<option value="${label}">进货价¥${fmt(v.unitCost)}</option>`).join('');
}

function onSaleProductSelect() {
    const val = document.getElementById('s-product').value;
    const item = _productMap[val];
    if (item) {
        document.getElementById('s-cost').value = item.unitCost;
        updateCostPreview();
    }
}

function submitSale() {
    const productVal = document.getElementById('s-product').value.trim();
    const item = _productMap[productVal];
    const design = item ? item.design : '';
    const model = item ? item.model : productVal;
    const quantity = document.getElementById('s-quantity').value;
    const price = document.getElementById('s-price').value;
    const cost = document.getElementById('s-cost').value;
    if (!productVal || !quantity || !price || !cost) { showToast('请填写完整信息', true); return; }
    const commissionVal = document.querySelector('input[name="s-commission"]:checked')?.value || '0';
    addSale({ date: document.getElementById('s-date').value, platform: currentPlatform, design, model, quantity, sellingPrice: price, purchaseCost: cost, logistics: document.getElementById('s-logistics').value || 4, packaging: document.getElementById('s-packaging').value || 3, insurance: document.getElementById('s-insurance').value || 1.5, commission: commissionVal, note: document.getElementById('s-note').value });
    showToast('销售记录已保存 ✓ 云端同步中');
    document.getElementById('s-product').value = '';
    ['s-price', 's-cost', 's-note'].forEach(id => document.getElementById(id).value = '');
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
    document.getElementById('returns-month-amount').textContent = '¥' + fmt(mr.reduce((s, r) => s + (r.refundAmount || 0), 0));
    document.getElementById('returns-month-label').textContent = returnsMonth + '月退货';
    document.getElementById('returns-amount-label').textContent = returnsMonth + '月损失';
    document.getElementById('returns-year-label').textContent = returnsYear + '年';
    document.getElementById('returns-year-title').textContent = returnsYear + '年损失';
    document.getElementById('returns-year-amount').textContent = '¥' + fmt(yr.reduce((s, r) => s + (r.refundAmount || 0), 0));
    document.getElementById('returns-count').textContent = '共' + allReturns.length + '条';

    const el = document.getElementById('returns-list');
    if (!allReturns.length) { el.innerHTML = '<div class="empty-state">↩️ 还没有退货记录</div>'; return; }
    const pCls = (p) => p === '淘宝' ? 'badge-orange' : p === '抖音' ? 'badge-douyin' : 'badge-xhs';
    el.innerHTML = `<div class="table-wrap"><table class="ref-table"><thead><tr><th>日期</th><th>平台</th><th>款名</th><th>型号</th><th>数量</th><th>物流</th><th>运费险</th><th>损失</th><th></th></tr></thead><tbody>` + allReturns.map(r => `<tr><td>${r.date}</td><td><span class="badge ${pCls(r.platform)}">${r.platform}</span></td><td>${r.design || '-'}</td><td>${r.model}</td><td>${r.quantity}件</td><td>¥${r.logistics || 4}</td><td>¥${r.insurance || 1.5}</td><td class="danger">¥${fmt(r.refundAmount || 0)}</td><td class="td-delete" onclick="confirmDeleteReturn('${r.id}')">✕</td></tr>`).join('') + `</tbody></table></div>`;
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
    const productVal = document.getElementById('r-product').value.trim();
    const item = _productMap[productVal];
    const design = item ? item.design : '';
    const model = item ? item.model : productVal;
    const quantity = document.getElementById('r-quantity').value;
    const logistics = document.getElementById('r-logistics').value;
    const insurance = document.getElementById('r-insurance').value;
    if (!productVal || !quantity) { showToast('请填写完整信息', true); return; }
    addReturn({ date: document.getElementById('r-date').value, platform: returnPlatform, design, model, quantity, logistics, insurance, reason: document.getElementById('r-reason').value });
    showToast('退货已记录，库存已回补 ✓');
    document.getElementById('r-product').value = '';
    document.getElementById('r-reason').value = '';
    document.getElementById('r-quantity').value = '1';
    document.getElementById('r-logistics').value = '4';
    document.getElementById('r-insurance').value = '1.5';
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
    el.innerHTML = `<div class="table-wrap"><table class="ref-table"><thead><tr><th>日期</th><th>类型</th><th>金额</th><th>备注</th><th></th></tr></thead><tbody>` + allPromos.map(p => `<tr><td>${p.date}</td><td><span class="badge ${p.type === '博主推广' ? 'badge-purple' : 'badge-orange'}">${p.type}</span></td><td class="danger">¥${fmt(p.amount)}</td><td>${p.note || '-'}</td><td class="td-delete" onclick="confirmDeletePromo('${p.id}')">✕</td></tr>`).join('') + `</tbody></table></div>`;
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
    const data = {};
    Object.values(KEYS).forEach(key => {
        const val = localStorage.getItem(key);
        if (val) data[key] = JSON.parse(val);
    });
    const backup = { version: '3.1', exportDate: new Date().toISOString(), app: '壳记账', data: data };
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = '壳记账_备份_' + getToday() + '.json';
    document.body.appendChild(link); link.click(); document.body.removeChild(link);
    const counts = Object.keys(data).length;
    showToast(`备份成功 ✓ 共 ${counts} 项数据`);
}

function restoreData(input) {
    const file = input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function (e) {
        try {
            const backup = JSON.parse(e.target.result);
            if (!backup.data) { showToast('文件格式不正确', true); input.value = ''; return; }
            const dateStr = backup.exportDate ? new Date(backup.exportDate).toLocaleDateString('zh-CN') : '未知';
            const keyCount = Object.keys(backup.data).length;
            showModal('确认恢复数据', `将恢复 ${keyCount} 项数据（备份日期：${dateStr}）。当前数据会被覆盖并同步到云端。`, () => {
                Object.entries(backup.data).forEach(([key, value]) => {
                    if (Array.isArray(value)) {
                        setStore(key, value);
                    }
                });
                showToast('恢复成功 ✓ 数据已同步到云端');
                refreshAll();
            });
        } catch { showToast('文件读取失败', true); }
        input.value = '';
    };
    reader.readAsText(file);
}


// ============================================
// 发工资
// ============================================

function getSalaries() { return getStore(KEYS.SALARIES); }
function addSalary(item) {
    const list = getSalaries();
    const record = {
        id: genId(), date: item.date || getToday(),
        amount: Number(item.amount),
        ratioA: Number(item.ratioA), ratioB: Number(item.ratioB),
        personA: Number(item.personA), personB: Number(item.personB),
        note: item.note || '', createdAt: Date.now()
    };
    list.unshift(record);
    setStore(KEYS.SALARIES, list);
    return record;
}
function deleteSalary(id) { setStore(KEYS.SALARIES, getSalaries().filter(s => s.id !== id)); }

let salaryRatioA = 50, salaryRatioB = 50;

function setSalaryRatio(a, b) {
    salaryRatioA = a;
    salaryRatioB = b;
    document.getElementById('ratio-55').classList.toggle('active', a === 50);
    document.getElementById('ratio-64').classList.toggle('active', a === 60);
    document.getElementById('ratio-73').classList.toggle('active', a === 70);
    updateSalaryPreview();
}

function updateSalaryPreview() {
    const amount = Number(document.getElementById('sal-amount').value) || 0;
    const preview = document.getElementById('sal-preview');
    if (amount > 0) {
        preview.style.display = 'block';
        document.getElementById('sal-person-a').textContent = '¥' + fmt(amount * salaryRatioA / 100);
        document.getElementById('sal-person-b').textContent = '¥' + fmt(amount * salaryRatioB / 100);
    } else {
        preview.style.display = 'none';
    }
}

function renderSalary() {
    const salaries = getSalaries();

    // 计算余额
    const allSales = getSales();
    const allReturns = getReturns();
    const allSupplies = getSupplies();
    const allPromos = getStore(KEYS.PROMOTIONS);
    const allOrders = getStore(KEYS.ORDERS);
    const totalProfit = allSales.reduce((s, x) => s + (x.profit || 0), 0)
        - allReturns.reduce((s, x) => s + (x.refundAmount || 0), 0)
        - allSupplies.reduce((s, x) => s + (x.amount || 0), 0)
        - allPromos.reduce((s, x) => s + (x.amount || 0), 0)
        - allOrders.reduce((s, x) => s + (x.amount || 0), 0);
    const totalPaid = salaries.reduce((s, x) => s + (x.amount || 0), 0);
    const balance = totalProfit - totalPaid;

    document.getElementById('sal-total-profit').textContent = '¥' + fmt(totalProfit);
    document.getElementById('sal-total-paid').textContent = '¥' + fmt(totalPaid);
    const balEl = document.getElementById('sal-balance');
    balEl.textContent = '¥' + fmt(balance);
    balEl.className = 'stock-num ' + (balance >= 0 ? 'success' : 'danger');

    document.getElementById('salary-count').textContent = '共' + salaries.length + '条';
    const el = document.getElementById('salary-list');
    if (!salaries.length) { el.innerHTML = '<div class="empty-state">💸 还没有发放记录</div>'; return; }
    el.innerHTML = salaries.map(s => `<div class="list-item"><div class="item-top"><div class="item-top-left"><span class="badge badge-green">发工资</span><span class="item-model">${s.ratioA}:${s.ratioB} 分配</span></div><button class="item-delete" onclick="confirmDeleteSalary('${s.id}')">✕</button></div><div class="item-stats"><div class="item-stat"><span class="item-stat-label">总金额</span><span class="item-stat-value danger">¥${fmt(s.amount)}</span></div><div class="item-stat"><span class="item-stat-label">合伙人A</span><span class="item-stat-value">¥${fmt(s.personA)}</span></div><div class="item-stat"><span class="item-stat-label">合伙人B</span><span class="item-stat-value">¥${fmt(s.personB)}</span></div></div><div class="item-bottom"><span>${s.date}</span>${s.note ? `<span>${s.note}</span>` : ''}</div></div>`).join('');
}

function submitSalary() {
    const amount = Number(document.getElementById('sal-amount').value);
    if (!amount || amount <= 0) { showToast('请输入发放金额', true); return; }
    const personA = amount * salaryRatioA / 100;
    const personB = amount * salaryRatioB / 100;
    addSalary({
        date: document.getElementById('sal-date').value,
        amount, ratioA: salaryRatioA, ratioB: salaryRatioB,
        personA, personB,
        note: document.getElementById('sal-note').value
    });
    showToast('工资已发放 ✓ 云端同步中');
    document.getElementById('sal-amount').value = '';
    document.getElementById('sal-note').value = '';
    document.getElementById('sal-preview').style.display = 'none';
    toggleForm('salary');
    refreshAll();
}

function confirmDeleteSalary(id) { showModal('确认删除', '确定撤销这条工资发放记录吗？', () => { deleteSalary(id); showToast('已删除'); refreshAll(); }); }


// ============================================
// 成本参考表
// ============================================

function getShellCosts() { return getStore(KEYS.SHELL_COSTS); }
function addShellCost(item) {
    const list = getShellCosts();
    list.push({ id: genId(), factory: item.factory.trim(), shell: item.shell.trim(), magnetic: Number(item.magnetic) || 0, nonMagnetic: Number(item.nonMagnetic) || 0, specialName: item.specialName || '', specialPrice: Number(item.specialPrice) || 0, note: item.note || '' });
    setStore(KEYS.SHELL_COSTS, list);
}
function updateShellCost(id, item) {
    const list = getShellCosts();
    const idx = list.findIndex(s => s.id === id);
    if (idx === -1) return;
    list[idx] = { ...list[idx], factory: item.factory.trim(), shell: item.shell.trim(), magnetic: Number(item.magnetic) || 0, nonMagnetic: Number(item.nonMagnetic) || 0, specialName: item.specialName || '', specialPrice: Number(item.specialPrice) || 0, note: item.note || '' };
    setStore(KEYS.SHELL_COSTS, list);
}
function deleteShellCost(id) { setStore(KEYS.SHELL_COSTS, getShellCosts().filter(s => s.id !== id)); }

function getBracketCosts() { return getStore(KEYS.BRACKET_COSTS); }
function addBracketCost(item) {
    const list = getBracketCosts();
    list.push({ id: genId(), factory: item.factory.trim(), bracket: item.bracket.trim(), price: Number(item.price) || 0, specialName: item.specialName || '', specialPrice: Number(item.specialPrice) || 0, note: item.note || '' });
    setStore(KEYS.BRACKET_COSTS, list);
}
function updateBracketCost(id, item) {
    const list = getBracketCosts();
    const idx = list.findIndex(b => b.id === id);
    if (idx === -1) return;
    list[idx] = { ...list[idx], factory: item.factory.trim(), bracket: item.bracket.trim(), price: Number(item.price) || 0, specialName: item.specialName || '', specialPrice: Number(item.specialPrice) || 0, note: item.note || '' };
    setStore(KEYS.BRACKET_COSTS, list);
}
function deleteBracketCost(id) { setStore(KEYS.BRACKET_COSTS, getBracketCosts().filter(b => b.id !== id)); }

let editingShellId = null;
let editingBracketId = null;

function renderCostRef() {
    const shells = getShellCosts();
    document.getElementById('shell-cost-count').textContent = '共' + shells.length + '条';
    const sb = document.getElementById('shell-cost-body');
    if (!shells.length) { sb.innerHTML = '<tr><td colspan="8" class="empty-state">暂无记录，点上方新增</td></tr>'; }
    else { sb.innerHTML = shells.map(s => `<tr><td>${s.factory}</td><td>${s.shell}</td><td>¥${fmt(s.magnetic)}</td><td>¥${fmt(s.nonMagnetic)}</td><td>${s.specialName || '-'}</td><td>${s.specialPrice ? '¥' + fmt(s.specialPrice) : '-'}</td><td>${s.note || '-'}</td><td><span class="td-edit" onclick="editShellCost('${s.id}')">✏️</span> <span class="td-delete" onclick="confirmDeleteShellCost('${s.id}')">✕</span></td></tr>`).join(''); }

    const brackets = getBracketCosts();
    document.getElementById('bracket-cost-count').textContent = '共' + brackets.length + '条';
    const bb = document.getElementById('bracket-cost-body');
    if (!brackets.length) { bb.innerHTML = '<tr><td colspan="7" class="empty-state">暂无记录，点上方新增</td></tr>'; }
    else { bb.innerHTML = brackets.map(b => `<tr><td>${b.factory}</td><td>${b.bracket}</td><td>¥${fmt(b.price)}</td><td>${b.specialName || '-'}</td><td>${b.specialPrice ? '¥' + fmt(b.specialPrice) : '-'}</td><td>${b.note || '-'}</td><td><span class="td-edit" onclick="editBracketCost('${b.id}')">✏️</span> <span class="td-delete" onclick="confirmDeleteBracketCost('${b.id}')">✕</span></td></tr>`).join(''); }
}

function editShellCost(id) {
    const item = getShellCosts().find(s => s.id === id);
    if (!item) return;
    editingShellId = id;
    document.getElementById('sc-factory').value = item.factory;
    document.getElementById('sc-shell').value = item.shell;
    document.getElementById('sc-magnetic').value = item.magnetic || '';
    document.getElementById('sc-nonmagnetic').value = item.nonMagnetic || '';
    document.getElementById('sc-special-name').value = item.specialName || '';
    document.getElementById('sc-special-price').value = item.specialPrice || '';
    document.getElementById('sc-note').value = item.note || '';
    document.getElementById('shellcost-form').style.display = 'block';
    document.getElementById('shellcost-arrow').textContent = '▲';
    document.querySelector('#shellcost-form .btn-primary').textContent = '💾 更新';
    document.getElementById('shellcost-form').scrollIntoView({ behavior: 'smooth' });
}

function editBracketCost(id) {
    const item = getBracketCosts().find(b => b.id === id);
    if (!item) return;
    editingBracketId = id;
    document.getElementById('bc-factory').value = item.factory;
    document.getElementById('bc-bracket').value = item.bracket;
    document.getElementById('bc-price').value = item.price || '';
    document.getElementById('bc-special-name').value = item.specialName || '';
    document.getElementById('bc-special-price').value = item.specialPrice || '';
    document.getElementById('bc-note').value = item.note || '';
    document.getElementById('bracketcost-form').style.display = 'block';
    document.getElementById('bracketcost-arrow').textContent = '▲';
    document.querySelector('#bracketcost-form .btn-primary').textContent = '💾 更新';
    document.getElementById('bracketcost-form').scrollIntoView({ behavior: 'smooth' });
}

function submitShellCost() {
    const factory = document.getElementById('sc-factory').value.trim();
    const shell = document.getElementById('sc-shell').value.trim();
    if (!factory || !shell) { showToast('请填写工厂和壳体名称', true); return; }
    const data = { factory, shell, magnetic: document.getElementById('sc-magnetic').value, nonMagnetic: document.getElementById('sc-nonmagnetic').value, specialName: document.getElementById('sc-special-name').value, specialPrice: document.getElementById('sc-special-price').value, note: document.getElementById('sc-note').value };
    if (editingShellId) { updateShellCost(editingShellId, data); showToast('已更新 ✓'); editingShellId = null; }
    else { addShellCost(data); showToast('壳体成本已保存 ✓'); }
    ['sc-factory', 'sc-shell', 'sc-magnetic', 'sc-nonmagnetic', 'sc-special-name', 'sc-special-price', 'sc-note'].forEach(id => document.getElementById(id).value = '');
    document.querySelector('#shellcost-form .btn-primary').textContent = '💾 保存';
    toggleForm('shellcost');
    renderCostRef();
}

function submitBracketCost() {
    const factory = document.getElementById('bc-factory').value.trim();
    const bracket = document.getElementById('bc-bracket').value.trim();
    if (!factory || !bracket) { showToast('请填写工厂和工艺类型', true); return; }
    const data = { factory, bracket, price: document.getElementById('bc-price').value, specialName: document.getElementById('bc-special-name').value, specialPrice: document.getElementById('bc-special-price').value, note: document.getElementById('bc-note').value };
    if (editingBracketId) { updateBracketCost(editingBracketId, data); showToast('已更新 ✓'); editingBracketId = null; }
    else { addBracketCost(data); showToast('支架成本已保存 ✓'); }
    ['bc-factory', 'bc-bracket', 'bc-price', 'bc-special-name', 'bc-special-price', 'bc-note'].forEach(id => document.getElementById(id).value = '');
    document.querySelector('#bracketcost-form .btn-primary').textContent = '💾 保存';
    toggleForm('bracketcost');
    renderCostRef();
}

function confirmDeleteShellCost(id) { showModal('确认删除', '删除这条壳体成本记录？', () => { deleteShellCost(id); showToast('已删除'); renderCostRef(); }); }
function confirmDeleteBracketCost(id) { showModal('确认删除', '删除这条支架成本记录？', () => { deleteBracketCost(id); showToast('已删除'); renderCostRef(); }); }
