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
    BRACKET_COSTS: 'shell_ref_brackets',
    COUPON_SETTINGS: 'shell_coupon_settings',
    INVENTORY_BASELINE: 'shell_inventory_baseline',
    INVENTORY_ADJUSTMENTS: 'shell_inventory_adjustments'
};

function genId() { return Date.now().toString(36) + Math.random().toString(36).substr(2, 6); }
function getToday() { return new Date().toISOString().split('T')[0]; }
function fmt(n) { return (n === undefined || n === null || isNaN(n)) ? '0.00' : Number(n).toFixed(2); }
function numOrDefault(value, fallback) {
    if (value === undefined || value === null || value === '') return fallback;
    const n = Number(value);
    return isNaN(n) ? fallback : n;
}

const CHINA_PROVINCES = [
    '北京', '天津', '河北', '山西', '内蒙古', '辽宁', '吉林', '黑龙江',
    '上海', '江苏', '浙江', '安徽', '福建', '江西', '山东', '河南',
    '湖北', '湖南', '广东', '广西', '海南', '重庆', '四川', '贵州',
    '云南', '西藏', '陕西', '甘肃', '青海', '宁夏', '新疆'
];

function saleOrderId(s) { return s.orderId || s.id; }
function saleLineId(s) { return s.id; }
function getReturnItems(r) {
    if (Array.isArray(r.items) && r.items.length) return r.items;
    return [{
        saleId: r.saleId || '',
        design: r.design || '',
        model: r.model || '',
        quantity: Number(r.quantity) || 0,
        sellingPrice: Number(r.sellingPrice) || 0,
        purchaseCost: Number(r.purchaseCost) || 0
    }];
}
function getReturnLossAmount(r) {
    if (r.lossAmount !== undefined) return Number(r.lossAmount) || 0;
    return ((Number(r.logistics) || 0) + (Number(r.insurance) || 0)) * (Number(r.quantity) || 1);
}
function getOrderNonReusableLoss(order, fallbackLogistics = 3, fallbackInsurance = 0) {
    const logistics = Number(order?.logistics);
    const insurance = Number(order?.insurance);
    const fallback = numOrDefault(fallbackLogistics, 3) + numOrDefault(fallbackInsurance, 0);
    if (order && (!isNaN(logistics) || !isNaN(insurance))) {
        return (isNaN(logistics) ? 0 : logistics) + (isNaN(insurance) ? 0 : insurance);
    }
    const total = (isNaN(logistics) ? 0 : logistics) + (isNaN(insurance) ? 0 : insurance);
    return total > 0 ? total : fallback;
}
function hasReturnLossBooked(orderId) {
    return getReturns().some(r => r.orderId === orderId && getReturnLossAmount(r) > 0);
}
function getReturnProfitAdjustment(r) {
    if (r.profitAdjustment !== undefined) return Number(r.profitAdjustment) || 0;
    return Number(r.refundAmount) || 0;
}
function getReturnedQtyBySaleLine(orderId) {
    const map = {};
    getReturns().forEach(r => {
        if (orderId && r.orderId && r.orderId !== orderId) return;
        getReturnItems(r).forEach(item => {
            const id = item.saleId || item.id || '';
            if (!id) return;
            map[id] = (map[id] || 0) + (Number(item.quantity) || 0);
        });
    });
    return map;
}
function getSalesOrders() {
    const grouped = {};
    getSales().forEach(s => {
        const orderId = saleOrderId(s);
        if (!grouped[orderId]) {
            grouped[orderId] = {
                orderId,
                date: s.date,
                platform: s.platform,
                province: s.province || '',
                logistics: 0,
                packaging: 0,
                insurance: 0,
                commissionAmount: 0,
                totalRevenue: 0,
                totalCost: 0,
                profit: 0,
                quantity: 0,
                createdAt: s.createdAt || 0,
                items: []
            };
        }
        const order = grouped[orderId];
        order.date = order.date || s.date;
        order.platform = order.platform || s.platform;
        order.province = order.province || s.province || '';
        order.logistics += Number(s.logistics) || 0;
        order.packaging += Number(s.packaging) || 0;
        order.insurance += Number(s.insurance) || 0;
        order.commissionAmount += Number(s.commissionAmount) || 0;
        order.totalRevenue += Number(s.totalRevenue) || 0;
        order.totalCost += Number(s.totalCost) || 0;
        order.profit += Number(s.profit) || 0;
        order.quantity += Number(s.quantity) || 0;
        order.createdAt = Math.max(order.createdAt, s.createdAt || 0);
        order.items.push({
            saleId: saleLineId(s),
            design: s.design || '',
            model: s.model || '',
            quantity: Number(s.quantity) || 0,
            sellingPrice: Number(s.sellingPrice) || 0,
            purchaseCost: Number(s.purchaseCost) || 0,
            totalRevenue: Number(s.totalRevenue) || 0,
            productCost: (Number(s.purchaseCost) || 0) * (Number(s.quantity) || 0)
        });
    });
    return Object.values(grouped).sort((a, b) => (b.date || '').localeCompare(a.date || '') || b.createdAt - a.createdAt);
}

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
    const lo = Number(item.logistics) || 0, pk = Number(item.packaging) || 0, ins = Number(item.insurance) || 0;
    const commRate = Number(item.commission) || 0;
    const totalRevenue = sp * qty;
    const commAmount = totalRevenue * commRate;
    const productCost = pc * qty;
    const totalCost = productCost + lo + pk + ins + commAmount;
    const record = {
        id: genId(), orderId: item.orderId || genId(), date: item.date || getToday(), platform: item.platform,
        province: item.province || '',
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
function deleteSalesOrder(orderId) { setStore(KEYS.SALES, getSales().filter(s => saleOrderId(s) !== orderId)); }

// --- 退货 ---
function getReturns() { return getStore(KEYS.RETURNS); }
function addReturn(item) {
    const list = getReturns();
    const items = Array.isArray(item.items) ? item.items : [];
    const qty = items.length ? items.reduce((s, x) => s + (Number(x.quantity) || 0), 0) : Number(item.quantity);
    const lo = numOrDefault(item.logistics, 3);
    const ins = numOrDefault(item.insurance, 0);
    const lossAmount = item.lossAmount !== undefined ? Number(item.lossAmount) : lo + ins;
    const profitAdjustment = item.profitAdjustment !== undefined ? Number(item.profitAdjustment) : lossAmount * qty;
    const record = {
        id: genId(), orderId: item.orderId || '', date: item.date || getToday(), platform: item.platform,
        province: item.province || '',
        design: (item.design || '').trim(), model: (item.model || '').trim(),
        quantity: qty, logistics: lo, insurance: ins,
        lossAmount,
        returnedRevenue: Number(item.returnedRevenue) || 0,
        returnedProductCost: Number(item.returnedProductCost) || 0,
        packagingCredit: Number(item.packagingCredit) || 0,
        profitAdjustment,
        refundAmount: profitAdjustment,
        items,
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

function inventoryItemKey(design, model) { return (design || '') + '|||' + (model || ''); }
function parseInventoryItemKey(encodedKey) {
    const raw = decodeURIComponent(encodedKey || '');
    const idx = raw.indexOf('|||');
    if (idx === -1) return { design: '', model: raw };
    return { design: raw.slice(0, idx), model: raw.slice(idx + 3) };
}

// --- 库存汇总 ---
function getLegacyInventorySummary() {
    const purchases = getPurchases(), sales = getSales(), returns = getReturns();
    const map = {};
    const key = inventoryItemKey;

    purchases.forEach(p => {
        const k = key(p.design, p.model);
        if (!map[k]) map[k] = { design: p.design, model: p.model, totalPurchased: 0, totalSold: 0, totalReturned: 0, totalPurchaseCost: 0, totalReturnCost: 0, purchaseRecords: 0, saleEvents: [], returnTimes: [] };
        map[k].totalPurchased += p.quantity;
        map[k].totalPurchaseCost += p.totalCost;
        map[k].purchaseRecords++;
    });

    sales.forEach(s => {
        const k = key(s.design || '', s.model);
        if (!map[k]) map[k] = { design: s.design || '', model: s.model, totalPurchased: 0, totalSold: 0, totalReturned: 0, totalPurchaseCost: 0, totalReturnCost: 0, purchaseRecords: 0, saleEvents: [], returnTimes: [] };
        map[k].totalSold += s.quantity;
        map[k].saleEvents.push({ time: s.createdAt || Date.parse(s.date || '') || 0, quantity: Number(s.quantity) || 0 });
    });

    returns.forEach(r => {
        getReturnItems(r).forEach(item => {
            const design = item.design || r.design || '';
            const model = item.model || r.model;
            const qty = Number(item.quantity) || 0;
            const k = key(design, model);
            if (!map[k]) map[k] = { design, model, totalPurchased: 0, totalSold: 0, totalReturned: 0, totalPurchaseCost: 0, totalReturnCost: 0, purchaseRecords: 0, saleEvents: [], returnTimes: [] };
            map[k].totalReturned += qty;
            map[k].totalReturnCost += (Number(item.purchaseCost) || 0) * qty;
            map[k].returnTimes.push(r.createdAt || Date.parse(r.date || '') || 0);
        });
    });

    return Object.values(map).map(m => {
        const firstReturnTime = m.returnTimes.sort((a, b) => a - b)[0];
        const soldAfterReturn = firstReturnTime ? m.saleEvents.filter(e => e.time > firstReturnTime).reduce((s, e) => s + e.quantity, 0) : 0;
        const stock = m.totalPurchased > 0
            ? Math.max(0, m.totalPurchased - m.totalSold + m.totalReturned)
            : Math.max(0, m.totalReturned - soldAfterReturn);
        const avg = m.purchaseRecords > 0 ? m.totalPurchaseCost / m.totalPurchased : (m.totalReturned > 0 ? m.totalReturnCost / m.totalReturned : 0);
        return { ...m, stock, avgCost: Math.round(avg * 100) / 100, stockValue: Math.round(stock * avg * 100) / 100 };
    }).sort(compareInventoryItems);
}

function getInventorySummary() {
    const baseline = getInventoryBaseline();
    if (baseline.length) return getMigratedInventorySummary(baseline);
    return getLegacyInventorySummary();
}

function getInventoryBaselineTime(baseline = getInventoryBaseline()) {
    return baseline.reduce((max, item) => Math.max(max, Number(item.createdAt) || 0), 0);
}

function ensureMigratedInventoryItem(map, design, model) {
    const k = inventoryItemKey(design, model);
    if (!map[k]) {
        map[k] = {
            design: design || '',
            model: model || '',
            baselineStock: 0,
            baselineValue: 0,
            newPurchased: 0,
            adjustmentQty: 0,
            stock: 0,
            totalPurchased: 0,
            totalSold: 0,
            totalReturned: 0,
            totalPurchaseCost: 0,
            purchaseRecords: 0,
            avgCost: 0,
            stockValue: 0,
            inventoryMode: 'baseline'
        };
    }
    return map[k];
}

function getMigratedInventorySummary(baseline = getInventoryBaseline()) {
    const baselineTime = getInventoryBaselineTime(baseline);
    const map = {};

    baseline.forEach(item => {
        const entry = ensureMigratedInventoryItem(map, item.design || '', item.model || '');
        entry.baselineStock = Number(item.stock) || 0;
        entry.baselineValue = Number(item.stockValue) || 0;
        entry.stock = entry.baselineStock;
        entry.avgCost = Number(item.avgCost) || 0;
        entry.stockValue = entry.baselineValue;
        entry.totalPurchased = Number(item.totalPurchased) || 0;
        entry.totalSold = Number(item.totalSold) || 0;
        entry.totalReturned = Number(item.totalReturned) || 0;
    });

    getPurchases().forEach(p => {
        if ((Number(p.createdAt) || 0) <= baselineTime) return;
        const entry = ensureMigratedInventoryItem(map, p.design || '', p.model || '');
        const qty = Number(p.quantity) || 0;
        const amount = Number(p.totalCost) || qty * (Number(p.unitCost) || 0);
        entry.newPurchased += qty;
        entry.stock += qty;
        entry.totalPurchased += qty;
        entry.totalPurchaseCost += amount;
        entry.purchaseRecords++;
    });

    getInventoryAdjustments().forEach(adj => {
        const entry = ensureMigratedInventoryItem(map, adj.design || '', adj.model || '');
        const qty = Number(adj.quantity) || 0;
        entry.adjustmentQty += qty;
        entry.stock += qty;
    });

    return Object.values(map).map(item => {
        const stock = Math.max(0, Number(item.stock) || 0);
        const costBase = (Number(item.baselineValue) || 0) + (Number(item.totalPurchaseCost) || 0);
        const qtyBase = (Number(item.baselineStock) || 0) + (Number(item.newPurchased) || 0);
        const avg = qtyBase > 0 ? costBase / qtyBase : (Number(item.avgCost) || 0);
        return {
            ...item,
            stock,
            avgCost: Math.round(avg * 100) / 100,
            stockValue: Math.round(stock * avg * 100) / 100
        };
    }).sort(compareInventoryItems);
}

function compareInventoryItems(a, b) {
    if (invSortMode === 'value') {
        if (b.stockValue !== a.stockValue) return b.stockValue - a.stockValue;
        if (b.stock !== a.stock) return b.stock - a.stock;
    } else {
        if (b.stock !== a.stock) return b.stock - a.stock;
        if (b.stockValue !== a.stockValue) return b.stockValue - a.stockValue;
    }
    const ad = (a.design || '').localeCompare(b.design || '', 'zh-CN');
    if (ad !== 0) return ad;
    return (a.model || '').localeCompare(b.model || '', 'zh-CN');
}

function compareInventoryGroups(a, b) {
    const sa = a[1].reduce((s, i) => s + i.stock, 0);
    const sb = b[1].reduce((s, i) => s + i.stock, 0);
    const va = a[1].reduce((s, i) => s + i.stockValue, 0);
    const vb = b[1].reduce((s, i) => s + i.stockValue, 0);
    if (invSortMode === 'value') {
        if (vb !== va) return vb - va;
        if (sb !== sa) return sb - sa;
    } else {
        if (sb !== sa) return sb - sa;
        if (vb !== va) return vb - va;
    }
    return a[0].localeCompare(b[0], 'zh-CN');
}

function getInventoryBaseline() { return getStore(KEYS.INVENTORY_BASELINE); }
function getInventoryAdjustments() { return getStore(KEYS.INVENTORY_ADJUSTMENTS); }

function createInventoryBaseline(overwrite = false) {
    const existing = getInventoryBaseline();
    if (!overwrite && existing.length > 0) return { created: false, count: existing.length };

    const snapshot = getLegacyInventorySummary().map(item => ({
        id: genId(),
        date: getToday(),
        design: item.design || '',
        model: item.model || '',
        stock: Number(item.stock) || 0,
        avgCost: Number(item.avgCost) || 0,
        stockValue: Number(item.stockValue) || 0,
        totalPurchased: Number(item.totalPurchased) || 0,
        totalSold: Number(item.totalSold) || 0,
        totalReturned: Number(item.totalReturned) || 0,
        source: 'legacy_snapshot',
        createdAt: Date.now()
    }));

    setStore(KEYS.INVENTORY_BASELINE, snapshot);
    return { created: true, count: snapshot.length };
}

function confirmCreateInventoryBaseline() {
    const existing = getInventoryBaseline();
    const msg = existing.length
        ? `已存在 ${existing.length} 条库存基准。重新生成会覆盖旧基准，但不会删除入库、销售、退货等原始数据。确定重新生成吗？`
        : '将根据当前入库、销售、退货记录生成一份库存基准快照。不会删除任何旧数据。确定生成吗？';
    showModal('生成库存基准', msg, () => {
        const result = createInventoryBaseline(true);
        showToast(`库存基准已生成 ✓ 共 ${result.count} 个款型`);
        refreshAll();
    });
}

function updateMigrationStatus() {
    const el = document.getElementById('migration-status');
    if (!el) return;
    const baseline = getInventoryBaseline();
    const adjustments = getInventoryAdjustments();
    if (!baseline.length) {
        el.textContent = '尚未生成库存基准';
        el.className = 'data-mgmt-desc warning';
    } else {
        const totalStock = baseline.reduce((s, x) => s + (Number(x.stock) || 0), 0);
        const totalValue = baseline.reduce((s, x) => s + (Number(x.stockValue) || 0), 0);
        el.textContent = `已有基准：${baseline.length} 个款型，${totalStock} 件，积压 ¥${fmt(totalValue)}；库存调整 ${adjustments.length} 条`;
        el.className = 'data-mgmt-desc success';
    }
}

function addInventoryAdjustment(item) {
    const list = getInventoryAdjustments();
    const qty = Number(item.quantity) || 0;
    if (!qty) return null;
    const now = item.createdAt || Date.now();
    const record = {
        id: genId(),
        date: item.date || getToday(),
        design: item.design || '',
        model: item.model || '',
        quantity: qty,
        reason: item.reason || '库存盘点',
        note: item.note || '',
        batchId: item.batchId || '',
        createdAt: now
    };
    list.unshift(record);
    setStore(KEYS.INVENTORY_ADJUSTMENTS, list);
    return record;
}

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    }[ch]));
}

function formatInventoryTime(ts) {
    if (!ts) return '尚未盘点';
    const d = new Date(Number(ts));
    if (isNaN(d.getTime())) return '尚未盘点';
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    return `${yyyy}/${mm}/${dd} ${hh}:${mi}`;
}

function getInventoryLastCheckTime(design) {
    const scoped = arguments.length > 0;
    const target = design || '';
    return getInventoryAdjustments().reduce((latest, adj) => {
        if (scoped && (adj.design || '') !== target) return latest;
        return Math.max(latest, Number(adj.createdAt) || 0);
    }, 0);
}

function toggleInventoryDesign(encodedDesign) {
    const design = decodeURIComponent(encodedDesign || '');
    expandedInventoryDesign = expandedInventoryDesign === design ? null : design;
    renderInventory();
}

function changeInventoryDraft(btn, delta) {
    const row = btn.closest('.inventory-count-row');
    const input = row?.querySelector('.inventory-count-input');
    if (!input) return;
    const current = Number(input.value);
    const next = Math.max(0, (isNaN(current) ? 0 : current) + (Number(delta) || 0));
    input.value = next;
    onInventoryCountInput(input);
}

function onInventoryCountInput(input) {
    const value = Number(input.value);
    const invalid = input.value === '' || !Number.isInteger(value) || value < 0;
    input.classList.toggle('input-error', invalid);
    const row = input.closest('.inventory-count-row');
    const current = Number(input.dataset.current) || 0;
    row?.classList.toggle('inventory-row-changed', !invalid && value !== current);
    updateInventoryDraftPanel(input.closest('.inventory-design-panel'));
}

function updateInventoryDraftPanel(panel) {
    if (!panel) return;
    const inputs = Array.from(panel.querySelectorAll('.inventory-count-input'));
    let changed = 0, invalid = 0;
    inputs.forEach(input => {
        const value = Number(input.value);
        const bad = input.value === '' || !Number.isInteger(value) || value < 0;
        const current = Number(input.dataset.current) || 0;
        if (bad) invalid++;
        else if (value !== current) changed++;
    });
    const countEl = panel.querySelector('.inventory-pending-count');
    const saveBtn = panel.querySelector('.inventory-save-btn');
    if (countEl) countEl.textContent = changed + ' 个型号待保存';
    if (saveBtn) saveBtn.disabled = changed === 0 || invalid > 0;
}

function saveInventoryDesign(encodedDesign, btn) {
    const design = decodeURIComponent(encodedDesign || '');
    const panel = btn.closest('.inventory-design-panel');
    const designLabel = panel?.dataset.designLabel || design || '未分类';
    const inputs = Array.from(panel?.querySelectorAll('.inventory-count-input') || []);
    const now = Date.now();
    const batchId = genId();
    const list = getInventoryAdjustments();
    let changed = 0;

    for (const input of inputs) {
        const target = Number(input.value);
        if (input.value === '' || !Number.isInteger(target) || target < 0) {
            showToast('请检查库存数量，只能填写 0 或正整数', true);
            return;
        }
        const current = Number(input.dataset.current) || 0;
        const delta = target - current;
        if (!delta) continue;
        changed++;
        list.unshift({
            id: genId(),
            date: getToday(),
            design,
            model: input.dataset.model || '',
            quantity: delta,
            reason: '单款库存盘点',
            note: `系统${current}件，盘点${target}件`,
            batchId,
            createdAt: now
        });
    }

    if (!changed) {
        showToast('这个款库存没有变化');
        return;
    }

    setStore(KEYS.INVENTORY_ADJUSTMENTS, list);
    expandedInventoryDesign = design;
    showToast(`已保存 ${designLabel}：${changed} 个型号`);
    renderInventory();
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
    const msal = getStore(KEYS.SALARIES).filter(s => s.date && s.date.startsWith(prefix));

    const totalRevenue = ms.reduce((s, x) => s + x.totalRevenue, 0);
    const totalCost = ms.reduce((s, x) => s + x.totalCost, 0);
    const totalRefund = mr.reduce((s, x) => s + getReturnProfitAdjustment(x), 0);
    const totalSupplies = msup.reduce((s, x) => s + x.amount, 0);
    const totalPromo = mpromo.reduce((s, x) => s + x.amount, 0);
    const totalOrders = morders.reduce((s, x) => s + x.amount, 0);
    const totalSalary = msal.reduce((s, x) => s + (Number(x.amount) || 0), 0);
    const totalPurchaseSpend = mp.reduce((s, x) => s + x.totalCost, 0);
    const totalOutflow = totalSupplies + totalPromo + totalOrders + totalSalary;
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
        totalSalary: Math.round(totalSalary * 100) / 100,
        totalOutflow: Math.round(totalOutflow * 100) / 100,
        grossProfit: Math.round(grossProfit * 100) / 100,
        totalSoldQty: ms.reduce((s, x) => s + x.quantity, 0),
        totalReturnQty: mr.reduce((s, x) => s + x.quantity, 0),
        totalPurchaseSpend: Math.round(totalPurchaseSpend * 100) / 100,
        totalPurchaseQty: mp.reduce((s, x) => s + (Number(x.quantity) || 0), 0),
        expenseCount: msup.length + mpromo.length + morders.length + msal.length,
        profitRate: totalRevenue > 0 ? Math.round(grossProfit / totalRevenue * 10000) / 100 : 0,
        platformBreakdown: pb,
        purchaseCount: mp.length,
        suppliesCount: msup.length,
        promoCount: mpromo.length,
        orderCount: morders.length,
        salaryCount: msal.length
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

function getTransferFactorySummary(year) {
    const orders = year ? getStore(KEYS.ORDERS).filter(o => o.date && o.date.startsWith(String(year))) : getStore(KEYS.ORDERS);
    const map = {};
    orders.forEach(o => {
        const factory = o.factory || '未填写工厂';
        if (!map[factory]) map[factory] = { factory, totalAmount: 0, orders: 0 };
        map[factory].totalAmount += Number(o.amount) || 0;
        map[factory].orders++;
    });
    return Object.values(map).map(f => ({ ...f, totalAmount: Math.round(f.totalAmount * 100) / 100 })).sort((a, b) => b.totalAmount - a.totalAmount);
}

function getMonthlyTrend() {
    const now = new Date(), result = [];
    for (let i = 5; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        const r = getMonthlyReport(d.getFullYear(), d.getMonth() + 1);
        result.push({ label: (d.getMonth() + 1) + '月', stockIn: r.totalPurchaseSpend, outflow: r.totalOutflow });
    }
    return result;
}

const LIST_RANGE_OPTIONS = [
    { key: '1d', label: '近1日' },
    { key: '7d', label: '近7日' },
    { key: '1m', label: '近1月' },
    { key: '3m', label: '近3月' },
    { key: '6m', label: '近半年' },
    { key: '1y', label: '近1年' },
    { key: 'all', label: '全部' }
];

function formatLocalDate(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

function getRangeStartDate(range) {
    const d = new Date();
    if (range === 'all') return '';
    if (range === '1d') return formatLocalDate(d);
    if (range === '7d') d.setDate(d.getDate() - 6);
    else if (range === '1m') d.setMonth(d.getMonth() - 1);
    else if (range === '3m') d.setMonth(d.getMonth() - 3);
    else if (range === '6m') d.setMonth(d.getMonth() - 6);
    else if (range === '1y') d.setFullYear(d.getFullYear() - 1);
    return formatLocalDate(d);
}

function filterByDateRange(list, range) {
    const start = getRangeStartDate(range);
    if (!start) return list.slice();
    return list.filter(item => item.date && item.date >= start);
}

function getRangeLabel(range) {
    return LIST_RANGE_OPTIONS.find(opt => opt.key === range)?.label || '近1月';
}

function renderRangeFilters(id, type, activeRange) {
    const el = document.getElementById(id);
    if (!el) return;
    el.innerHTML = LIST_RANGE_OPTIONS.map(opt =>
        `<button class="filter-chip ${activeRange === opt.key ? 'active' : ''}" onclick="setListRange('${type}', '${opt.key}')">${opt.label}</button>`
    ).join('');
}

function setListRange(type, range) {
    if (type === 'purchase') { purchaseRange = range; renderPurchases(); }
    else if (type === 'orders') { orderRange = range; renderOrders(); }
    else if (type === 'supplies') { suppliesRange = range; renderSupplies(); updateExpenseBreakdown(); }
    else if (type === 'promotion') { promoRange = range; renderPromotion(); }
}

function getMonthlyAmountRows(list, year, amountField = 'amount') {
    return Array.from({ length: 12 }, (_, idx) => {
        const month = idx + 1;
        const prefix = year + '-' + String(month).padStart(2, '0');
        const rows = list.filter(item => item.date && item.date.startsWith(prefix));
        return {
            month,
            count: rows.length,
            amount: rows.reduce((sum, item) => sum + (Number(item[amountField]) || 0), 0)
        };
    });
}

function renderMonthBars(id, rows, selectedMonth, label) {
    const el = document.getElementById(id);
    if (!el) return;
    const max = Math.max(...rows.map(row => row.amount), 0) || 1;
    el.innerHTML = rows.map(row => {
        const height = Math.max(row.amount / max * 100, row.amount > 0 ? 4 : 1).toFixed(2);
        return `<div class="month-bar-item ${row.month === selectedMonth ? 'active' : ''}">
            <div class="month-bar-track">
                <div class="month-bar-fill" style="height:${height}%">
                    <div class="tooltip">${row.month}月${label}&#10;金额: ¥${fmt(row.amount)}&#10;记录: ${row.count}条</div>
                </div>
            </div>
            <div class="month-bar-label">${row.month}月</div>
            <div class="month-bar-value">¥${Math.round(row.amount)}</div>
        </div>`;
    }).join('');
}

// --- CSV ---
function generateCSV() {
    const BOM = '\uFEFF';
    let csv = '';
    csv += '【入库记录】\n日期,工厂,款名,型号,数量,单价,总金额,备注\n';
    getPurchases().forEach(p => { csv += `${p.date},${p.factory},${p.design},${p.model},${p.quantity},${p.unitCost},${p.totalCost},${p.note}\n`; });

    csv += '\n【辅料采购】\n日期,类目,品名,数量,金额,备注\n';
    getSupplies().forEach(s => { csv += `${s.date},${s.category},${s.name},${s.quantity},${s.amount},${s.note}\n`; });

    csv += '\n【销售记录】\n订单ID,日期,平台,地区,款名,型号,数量,售价,进货价,物流,包装,运费险,总收入,总成本,利润,备注\n';
    getSales().forEach(s => { csv += `${saleOrderId(s)},${s.date},${s.platform},${s.province || ''},${s.design},${s.model},${s.quantity},${s.sellingPrice},${s.purchaseCost},${s.logistics},${s.packaging},${s.insurance},${s.totalRevenue},${s.totalCost},${s.profit},${s.note}\n`; });

    csv += '\n【退货记录】\n订单ID,日期,平台,地区,退回商品,数量,扣回利润,原因\n';
    getReturns().forEach(r => {
        const products = getReturnItems(r).map(item => `${item.design ? item.design + ' ' : ''}${item.model}×${item.quantity}`).join(' / ');
        csv += `${r.orderId || ''},${r.date},${r.platform},${r.province || ''},${products},${r.quantity},${getReturnProfitAdjustment(r)},${r.reason}\n`;
    });

    csv += '\n【订货转账】\n日期,工厂,商品,转账金额,备注\n';
    getStore(KEYS.ORDERS).forEach(o => { csv += `${o.date},${o.factory},${o.product || ''},${o.amount},${o.note || ''}\n`; });

    csv += '\n【推广费用】\n日期,类型,金额,备注\n';
    getStore(KEYS.PROMOTIONS).forEach(p => { csv += `${p.date},${p.type},${p.amount},${p.note || ''}\n`; });

    csv += '\n【优惠券设置】\n商品,商品成本,物流,包装,合计成本,原价,日常价,直播/博主价,群内购,推荐店铺券,博主佣金率,博主佣金额,平台折扣,平台活动价,日常毛利,店播毛利,博主毛利,群内购毛利,平台活动毛利,备注\n';
    getCouponSettings().map(normalizeCouponSetting).forEach(c => {
        const calc = getCouponCalc(c);
        csv += `${c.name},${c.cost || 0},${c.logisticsCost || 0},${c.packagingCost || 0},${calc.baseCost},${c.originalPrice || 0},${c.dailyPrice || 0},${c.livePrice || 0},${c.groupPrice || 0},满${Math.round(c.originalPrice || 0)}减${Math.round(calc.couponOff || 0)},${c.commissionRate || 0},${calc.bloggerCommission},${c.platformDiscount || 0},${calc.platformPrice},${calc.dailyProfit},${calc.storeLiveProfit},${calc.bloggerProfit},${calc.groupProfit},${calc.platformProfit},${c.note || ''}\n`;
    });

    csv += '\n【库存汇总】\n款名,型号,入库总量,已售总量,退货总量,库存量,入库均价,积压成本\n';
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
let invSortMode = 'stock';
let expandedInventoryDesign = null;
let purchaseRange = '1m';
let orderRange = '1m';
let suppliesRange = '1m';
let promoRange = '1m';
let costRefSearch = '';

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
    updateMigrationStatus();
    if (typeof renderSalary === 'function') renderSalary();
    if (typeof renderCostRef === 'function') renderCostRef();
    if (typeof renderCoupons === 'function') renderCoupons();
}

// --- 视图切换 ---
function switchView(view) {
    document.querySelectorAll('.nav-item').forEach(el => el.classList.toggle('active', el.dataset.view === view));
    document.querySelectorAll('.view').forEach(el => el.classList.toggle('active', el.id === 'view-' + view));
    const titles = { dashboard: '首页概览', purchase: '库存管理', orders: '订货转账', supplies: '辅料采购', sales: '销售记录', promotion: '推广费用', returns: '退货记录', inventory: '库存管理', report: '月度报表', salary: '发工资', costref: '成本参考', coupons: '优惠券设置' };
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
        case 'coupons': renderCoupons(); break;
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
    const l = numOrDefault(document.getElementById('s-logistics').value, 3);
    const p = numOrDefault(document.getElementById('s-packaging').value, 3);
    const i = numOrDefault(document.getElementById('s-insurance').value, 0);
    document.getElementById('cost-preview').textContent = `物流${l} + 包装${p} + 运费险${i} = ${l + p + i}元/单`;
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
    renderReturnOrderPool(false);
}

function setInvSort(mode) {
    invSortMode = mode;
    document.getElementById('inv-sort-stock').classList.toggle('active', mode === 'stock');
    document.getElementById('inv-sort-value').classList.toggle('active', mode === 'value');
    renderInventory();
}

// --- 表单实时计算 ---
function bindFormListeners() {
    const sL = document.getElementById('s-logistics'), sP = document.getElementById('s-packaging'), sI = document.getElementById('s-insurance');
    [sL, sP, sI].forEach(el => el.addEventListener('input', () => { updateCostPreview(); updateSaleProfitPreview(); }));
    document.querySelectorAll('input[name="s-commission"]').forEach(r => r.addEventListener('change', updateSaleProfitPreview));
    document.querySelectorAll('.coupon-input').forEach(el => el.addEventListener('input', updateCouponPreview));
}




// ============================================
// 首页
// ============================================

let dashYear = new Date().getFullYear();
let dashMonth = new Date().getMonth() + 1;

function renderDashboard() {
    const report = getMonthlyReport(dashYear, dashMonth);

    document.getElementById('dash-month-label').textContent = dashYear + '年' + dashMonth + '月';
    document.getElementById('kpi-revenue-label').textContent = dashMonth + '月现金支出';
    document.getElementById('kpi-profit-label').textContent = '当前积压成本';
    document.getElementById('kpi-purchase-label').textContent = dashMonth + '月入库额';
    document.getElementById('kpi-supplies-label').textContent = dashMonth + '月辅料推广';

    const inv = getInventorySummary();
    const totalStock = inv.reduce((s, i) => s + i.stock, 0);
    const stockValue = inv.reduce((s, i) => s + i.stockValue, 0);
    const designSet = new Set(inv.filter(i => i.design).map(i => i.design));

    const outflowEl = document.getElementById('kpi-revenue');
    outflowEl.textContent = '¥' + fmt(report.totalOutflow);
    outflowEl.className = 'kpi-value danger';
    document.getElementById('kpi-sold-qty').textContent = `转账 ${fmt(report.totalOrders)} / 辅料 ${fmt(report.totalSupplies)} / 推广 ${fmt(report.totalPromo)} / 工资 ${fmt(report.totalSalary)}`;

    const stockValueEl = document.getElementById('kpi-profit');
    stockValueEl.textContent = '¥' + fmt(stockValue);
    stockValueEl.className = 'kpi-value danger';
    document.getElementById('kpi-profit-rate').textContent = `库存 ${totalStock} 件 · ${designSet.size || inv.length} 款`;

    const transferEl = document.getElementById('kpi-balance');
    transferEl.textContent = '¥' + fmt(report.totalOrders);
    transferEl.className = 'kpi-value danger';
    document.getElementById('kpi-balance-sub').textContent = `工厂转账 ${report.orderCount || 0} 笔`;

    document.getElementById('kpi-purchase').textContent = '¥' + fmt(report.totalPurchaseSpend);
    document.getElementById('kpi-purchase-qty').textContent = `${report.purchaseCount} 笔 · ${report.totalPurchaseQty || 0} 件`;

    document.getElementById('kpi-supplies').textContent = '¥' + fmt(report.totalSupplies + report.totalPromo);
    document.getElementById('kpi-supplies-qty').textContent = `辅料 ${report.suppliesCount} 笔 · 推广 ${report.promoCount || 0} 笔`;

    document.getElementById('dash-stock-count').textContent = totalStock;
    document.getElementById('dash-stock-value').textContent = '¥' + fmt(stockValue);
    document.getElementById('dash-model-count').textContent = designSet.size || inv.length;

    const recentEl = document.getElementById('recent-list');
    const toTime = item => item.createdAt || (item.date ? new Date(item.date).getTime() : 0);
    const pl = getPurchases().slice(0, 6).map(p => ({ icon: 'IN', title: `${p.factory} · ${p.design} ${p.model} ×${p.quantity}`, date: p.date, amount: '-¥' + fmt(p.totalCost), cls: 'danger', time: toTime(p) }));
    const ol = getStore(KEYS.ORDERS).slice(0, 6).map(o => ({ icon: 'TF', title: `${o.factory || '未填工厂'} · ${o.product || '订货转账'}`, date: o.date, amount: '-¥' + fmt(o.amount), cls: 'danger', time: toTime(o) }));
    const sul = getSupplies().slice(0, 6).map(s => ({ icon: 'SUP', title: `${s.category || '辅料'} · ${s.name || '-'}`, date: s.date, amount: '-¥' + fmt(s.amount), cls: 'danger', time: toTime(s) }));
    const prl = getStore(KEYS.PROMOTIONS).slice(0, 6).map(p => ({ icon: 'PRO', title: `${p.type || '推广'} · ${p.note || '-'}`, date: p.date, amount: '-¥' + fmt(p.amount), cls: 'danger', time: toTime(p) }));
    const sal = getStore(KEYS.SALARIES).slice(0, 4).map(s => ({ icon: 'PAY', title: `发工资 · ${s.note || '-'}`, date: s.date, amount: '-¥' + fmt(s.amount), cls: 'danger', time: toTime(s) }));
    const items = [...pl, ...ol, ...sul, ...prl, ...sal].sort((a, b) => b.time - a.time).slice(0, 8);

    if (!items.length) recentEl.innerHTML = '<div class="empty-state">No Records Found / 暂无记录</div>';
    else recentEl.innerHTML = items.map(i => `<div class="recent-item"><div class="recent-left"><span class="recent-icon" style="font-size:12px;font-weight:700;letter-spacing:1px;background:rgba(15,23,42,0.05);padding:4px 8px;border-radius:4px;">${i.icon}</span><div class="recent-info"><span class="recent-title">${i.title}</span><span class="recent-date">${i.date}</span></div></div><span class="recent-amount ${i.cls}">${i.amount}</span></div>`).join('');
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
    const purchases = getPurchases();
    const filteredPurchases = filterByDateRange(purchases, purchaseRange);

    renderRangeFilters('purchase-range-filters', 'purchase', purchaseRange);
    const countEl = document.getElementById('purchase-count');
    if (countEl) countEl.textContent = `${getRangeLabel(purchaseRange)} ${filteredPurchases.length}条 / 共${purchases.length}条`;

    // 初始化批量型号行（如果为空则添加一行）
    const modelRows = document.getElementById('p-model-rows');
    if (modelRows && modelRows.children.length === 0) { addModelRow(); }

    // 初始化补货表单
    initRestockDesignAutocomplete();
    const rsRows = document.getElementById('rs-model-rows');
    if (rsRows && rsRows.children.length === 0) { addRestockModelRow(); }
    const rsDate = document.getElementById('rs-date');
    if (rsDate && !rsDate.value) rsDate.value = getToday();

    renderPurchaseList(filteredPurchases);
}

function renderPurchaseList(list) {
    list = list.slice().sort((a, b) => b.date.localeCompare(a.date));
    const el = document.getElementById('purchase-list');
    if (!el) return;
    if (!list.length) { el.innerHTML = '<div class="empty-state">No Stock Records / 当前范围暂无入库记录</div>'; return; }
    el.innerHTML = `<div class="table-wrap"> <table class="ref-table"><thead><tr><th>日期</th><th>工厂</th><th>款名</th><th>型号</th><th>入库数量</th><th>单价</th><th>入库成本</th><th></th></tr></thead><tbody>` + list.map(p => `<tr><td>${p.date}</td><td>${p.factory}</td><td>${p.design}</td><td>${p.model}</td><td>${p.quantity}件</td><td>¥${fmt(p.unitCost || 0)}</td><td class="danger">¥${fmt(p.totalCost || 0)}</td><td class="td-delete" onclick="confirmDeletePurchase('${p.id}')">✕</td></tr>`).join('') + `</tbody></table></div>`;
}

// --- 批量型号行管理 ---
function addModelRow() {
    const container = document.getElementById('p-model-rows');
    const row = document.createElement('div');
    row.className = 'model-row';
    row.innerHTML = `
            <div class="model-row-input">
                <div class="autocomplete-wrap">
                    <input type="text" class="form-input model-input" placeholder="输入筛选或点击选型号" autocomplete="off">
                        <div class="autocomplete-list"></div>
                </div>
        </div>
        <div class="model-row-qty">
            <input type="number" class="form-input qty-input" placeholder="数量" min="1">
        </div>
        <button type="button" class="model-row-del" onclick="removeModelRow(this)" title="删除此行">✕</button>
        `;
    container.appendChild(row);
    // 绑定自动补全
    const input = row.querySelector('.model-input');
    const list = row.querySelector('.autocomplete-list');
    bindModelAutocomplete(input, list);
}

function removeModelRow(btn) {
    const container = document.getElementById('p-model-rows');
    if (container.children.length <= 1) { showToast('至少保留一行型号', true); return; }
    btn.closest('.model-row').remove();
}

function submitPurchase() {
    const factory = document.getElementById('p-factory').value.trim();
    const design = document.getElementById('p-design').value.trim();
    const unitCost = document.getElementById('p-unitcost').value;
    if (!factory || !design || !unitCost) { showToast('请填写工厂、款名和单价', true); return; }
    if (Number(unitCost) <= 0) { showToast('单价必须大于0', true); return; }

    const rows = document.querySelectorAll('#p-model-rows .model-row');
    const entries = [];
    for (const row of rows) {
        const model = row.querySelector('.model-input').value.trim();
        const quantity = row.querySelector('.qty-input').value;
        if (model && quantity && Number(quantity) > 0) {
            entries.push({ model, quantity });
        }
    }

    if (entries.length === 0) { showToast('请至少填写一个型号和数量', true); return; }

    const date = document.getElementById('p-date').value;
    const note = document.getElementById('p-note').value;

    entries.forEach(e => {
        addPurchase({ date, factory, design, model: e.model, quantity: e.quantity, unitCost, note });
    });

    showToast(`已新增 ${entries.length} 条入库记录 ✓ 云端同步中`);
    document.getElementById('p-factory').value = '';
    document.getElementById('p-design').value = '';
    document.getElementById('p-unitcost').value = '';
    document.getElementById('p-note').value = '';
    // 重置型号行为一行
    const container = document.getElementById('p-model-rows');
    container.innerHTML = '';
    addModelRow();
    toggleForm('purchase');
    refreshAll();
}

function confirmDeletePurchase(id) { showModal('确认删除', '确定要删除这条入库记录吗？库存也会随之减少。', () => { deletePurchase(id); showToast('已删除'); refreshAll(); }); }

// --- 补货功能 ---
let _designMap = {}; // design -> {factory, unitCost}

function getDesignList() {
    const purchases = getPurchases();
    _designMap = {};
    purchases.forEach(p => {
        // 用最新一条（list已按时间倒序）
        if (!_designMap[p.design]) {
            _designMap[p.design] = { factory: p.factory, unitCost: p.unitCost || 0 };
        }
    });
    return Object.keys(_designMap);
}

function initRestockDesignAutocomplete() {
    const input = document.getElementById('rs-design');
    const list = document.getElementById('rs-design-list');
    if (!input || !list) return;

    function showDesigns(filter) {
        const designs = getDesignList();
        list.innerHTML = '';
        const matches = filter ? designs.filter(d => d.toLowerCase().includes(filter.toLowerCase())) : designs;
        matches.forEach(d => {
            const info = _designMap[d];
            const div = document.createElement('div');
            div.className = 'autocomplete-item';
            div.innerHTML = `<span>${d}</span> <span style="color:var(--color-text-muted);font-size:11px;margin-left:8px">${info.factory} · ¥${fmt(info.unitCost)}</span>`;
            div.addEventListener('mousedown', () => {
                input.value = d;
                document.getElementById('rs-factory').value = info.factory;
                document.getElementById('rs-unitcost').value = info.unitCost;
                list.classList.remove('show');
            });
            list.appendChild(div);
        });
        if (matches.length) list.classList.add('show'); else list.classList.remove('show');
    }

    input.addEventListener('input', function () { showDesigns(this.value.trim()); });
    input.addEventListener('focus', function () { showDesigns(this.value.trim()); });
    input.addEventListener('blur', function () { setTimeout(() => list.classList.remove('show'), 150); });
}

function addRestockModelRow() {
    const container = document.getElementById('rs-model-rows');
    const row = document.createElement('div');
    row.className = 'model-row';
    row.innerHTML = `
            <div class="model-row-input">
                <div class="autocomplete-wrap">
                    <input type="text" class="form-input model-input" placeholder="输入筛选或点击选型号" autocomplete="off">
                        <div class="autocomplete-list"></div>
                </div>
        </div>
        <div class="model-row-qty">
            <input type="number" class="form-input qty-input" placeholder="数量" min="1">
        </div>
        <button type="button" class="model-row-del" onclick="removeModelRow(this)" title="删除此行">✕</button>
        `;
    container.appendChild(row);
    bindModelAutocomplete(row.querySelector('.model-input'), row.querySelector('.autocomplete-list'));
}

function submitRestock() {
    const design = document.getElementById('rs-design').value.trim();
    const factory = document.getElementById('rs-factory').value.trim();
    const unitCost = document.getElementById('rs-unitcost').value;
    if (!design || !factory || !unitCost) { showToast('请选择款式', true); return; }
    if (Number(unitCost) <= 0) { showToast('单价必须大于0', true); return; }

    const rows = document.querySelectorAll('#rs-model-rows .model-row');
    const entries = [];
    for (const row of rows) {
        const model = row.querySelector('.model-input').value.trim();
        const quantity = row.querySelector('.qty-input').value;
        if (model && quantity && Number(quantity) > 0) entries.push({ model, quantity });
    }
    if (entries.length === 0) { showToast('请至少填写一个型号和数量', true); return; }

    const date = document.getElementById('rs-date').value;
    const note = document.getElementById('rs-note').value;
    entries.forEach(e => { addPurchase({ date, factory, design, model: e.model, quantity: e.quantity, unitCost, note }); });

    showToast(`已补货 ${entries.length} 个型号 ✓ 云端同步中`);
    document.getElementById('rs-design').value = '';
    document.getElementById('rs-factory').value = '';
    document.getElementById('rs-unitcost').value = '';
    document.getElementById('rs-note').value = '';
    const container = document.getElementById('rs-model-rows');
    container.innerHTML = '';
    addRestockModelRow();
    toggleForm('restock');
    refreshAll();
}


// ============================================
// 订货转账
// ============================================

let orderYear = new Date().getFullYear();
let orderMonth = new Date().getMonth() + 1;

function renderOrders() {
    const allOrders = getStore(KEYS.ORDERS);
    const yPrefix = String(orderYear);
    const orders = allOrders.filter(o => o.date && o.date.startsWith(yPrefix));
    const filteredOrders = filterByDateRange(allOrders, orderRange);
    const ym = orderYear + '-' + String(orderMonth).padStart(2, '0');
    const monthOrders = allOrders.filter(o => o.date && o.date.startsWith(ym));
    document.getElementById('order-month-total').textContent = '¥' + fmt(monthOrders.reduce((s, o) => s + o.amount, 0));
    document.getElementById('order-month-label').textContent = orderMonth + '月转账';
    document.getElementById('order-all-total').textContent = '¥' + fmt(orders.reduce((s, o) => s + o.amount, 0));
    document.getElementById('order-year-label').textContent = orderYear + '年';
    document.getElementById('order-year-title').textContent = orderYear + '年总转账';
    document.getElementById('order-count').textContent = `${getRangeLabel(orderRange)} ${filteredOrders.length}条 / 共${allOrders.length}条`;
    renderRangeFilters('order-range-filters', 'orders', orderRange);
    renderMonthBars('order-month-bars', getMonthlyAmountRows(allOrders, orderYear), orderMonth, '转账');
    renderOrderFactoryOverview(orders);

    const dateEl = document.getElementById('ord-date');
    if (dateEl && !dateEl.value) dateEl.value = getToday();



    const el = document.getElementById('order-list');
    if (!filteredOrders.length) { el.innerHTML = '<div class="empty-state">No Transfer Records / 当前范围暂无转账记录</div>'; return; }
    filteredOrders.sort((a, b) => b.date.localeCompare(a.date));
    el.innerHTML = `<div class="table-wrap" > <table class="ref-table"><thead><tr><th>日期</th><th>工厂</th><th>商品</th><th>转账金额</th><th>备注</th><th></th></tr></thead><tbody>` + filteredOrders.map(o => `<tr><td>${o.date}</td><td>${o.factory}</td><td>${o.product || '-'}</td><td class="danger">¥${fmt(o.amount)}</td><td>${o.note || '-'}</td><td class="td-delete" onclick="confirmDeleteOrder('${o.id}')">✕</td></tr>`).join('') + `</tbody></table></div > `;
}

function renderOrderFactoryOverview(yearOrders) {
    const el = document.getElementById('order-factory-bar');
    if (!el) return;
    const map = {};
    yearOrders.forEach(o => {
        const factory = o.factory || '未填写工厂';
        if (!map[factory]) map[factory] = { factory, totalAmount: 0, orders: 0 };
        map[factory].totalAmount += Number(o.amount) || 0;
        map[factory].orders++;
    });
    const summary = Object.values(map).map(f => ({ ...f, totalAmount: Math.round(f.totalAmount * 100) / 100 })).sort((a, b) => b.totalAmount - a.totalAmount);
    if (!summary.length) {
        el.innerHTML = '<div class="empty-state" style="align-self:center;width:100%">暂无转账工厂数据</div>';
        return;
    }
    const maxAmount = Math.max(...summary.map(f => f.totalAmount), 0) || 1;
    el.innerHTML = summary.map(f => {
        const height = Math.max((f.totalAmount / maxAmount * 100), 1).toFixed(2) + '%';
        return `<div style="height: 100%; min-width: 64px; display: flex; flex-direction: column; align-items: center;">
            <div class="custom-bar-wrap">
                <div class="custom-bar" style="height: ${height};">
                    <div class="tooltip">工厂: ${escapeHtml(f.factory)}&#10;转账: ¥${fmt(f.totalAmount)}&#10;记录: ${f.orders}笔</div>
                </div>
            </div>
            <div style="margin-top: 12px; font-size: 13px; font-weight: 700; color: var(--color-text); text-align: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 80px;" title="${escapeHtml(f.factory)}">${escapeHtml(f.factory)}</div>
            <div style="margin-top: 4px; font-size: 12px; font-weight: 800; font-family: 'Inter', monospace; color: var(--color-text-muted); text-align: center;">¥${Math.round(f.totalAmount)}</div>
        </div>`;
    }).join('');
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
    const filteredSupplies = filterByDateRange(allSupplies, suppliesRange);
    const prefix = suppliesYear + '-' + String(suppliesMonth).padStart(2, '0');
    const monthTotal = allSupplies.filter(s => s.date && s.date.startsWith(prefix)).reduce((sum, s) => sum + s.amount, 0);
    const yearTotal = supplies.reduce((sum, s) => sum + s.amount, 0);

    document.getElementById('supplies-month-total').textContent = '¥' + fmt(monthTotal);
    document.getElementById('supplies-month-label').textContent = suppliesMonth + '月辅料支出';
    document.getElementById('supplies-all-total').textContent = '¥' + fmt(yearTotal);
    document.getElementById('supplies-year-label').textContent = suppliesYear + '年';
    document.getElementById('supplies-year-title').textContent = suppliesYear + '年辅料支出';
    document.getElementById('supplies-count').textContent = `${getRangeLabel(suppliesRange)} ${filteredSupplies.length}条 / 共${allSupplies.length}条`;
    renderRangeFilters('supplies-range-filters', 'supplies', suppliesRange);
    renderMonthBars('supplies-month-bars', getMonthlyAmountRows(allSupplies, suppliesYear), suppliesMonth, '辅料支出');

    function renderSuppliesList(list) {
        list = list.slice().sort((a, b) => b.date.localeCompare(a.date));
        const el = document.getElementById('supplies-list');
        if (!list.length) { el.innerHTML = '<div class="empty-state">No Supply Records / 暂无辅料采购记录</div>'; return; }
        el.innerHTML = `<div class="table-wrap" > <table class="ref-table"><thead><tr><th>日期</th><th>分类</th><th>名称</th><th>数量</th><th>金额</th><th>备注</th><th></th></tr></thead><tbody>` + list.map(s => `<tr><td>${s.date}</td><td>${s.category}</td><td>${s.name}</td><td>${s.quantity}</td><td class="danger">¥${fmt(s.amount)}</td><td>${s.note || '-'}</td><td class="td-delete" onclick="confirmDeleteSupply('${s.id}')">✕</td></tr>`).join('') + `</tbody></table></div > `;
    }
    renderSuppliesList(filteredSupplies);

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
        name: `好评返现 ${qty} 笔`, quantity: qty, amount: amount, note: ''
    });
    setStore(KEYS.SUPPLIES, supplies);
    document.getElementById('qe-cashback-qty').value = '1';
    showToast(`已记录好评返现 ${qty} 笔 ¥${amount} `);
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
    showToast(`已记录快递费 ¥${fmt(amount)} `);
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
    showToast(`已记录打样费用 ¥${fmt(amount)} `);
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
    showToast(`已记录生活消费 ¥${fmt(amount)} `);
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
// 固定型号列表（池子）
const MODELS = [
    'iPhone13', 'iPhone14', 'iPhone14p', 'iPhone14pm',
    'iPhone15', 'iPhone15pro', 'iPhone15pm',
    'iPhone16', 'iPhone16pro', 'iPhone16pm',
    'iPhone17', 'iPhone17pro', 'iPhone17pm',
    'Mate60 Pro', 'Mate60 Pro+',
    'Mate70 Pro', 'Mate70 Pro+',
    'Mate80', 'Mate80 Pro', 'Mate80 ProMax',
    'Pura70 Pro', 'Pura70 Pro+',
    'Pura80 Pro', 'Pura80 Pro+',
    'XIAOMI15', 'XIAOMI15P'
];

// 为型号输入框绑定自动补全
function bindModelAutocomplete(input, list) {
    input.addEventListener('input', function () {
        const val = this.value.toLowerCase().trim();
        list.innerHTML = '';
        list.classList.remove('show');
        if (!val) {
            // 输入为空时显示全部
            MODELS.forEach(model => {
                const div = document.createElement('div');
                div.className = 'autocomplete-item';
                div.textContent = model;
                div.addEventListener('mousedown', () => { input.value = model; list.classList.remove('show'); });
                list.appendChild(div);
            });
            list.classList.add('show');
            return;
        }
        const matches = MODELS.filter(m => m.toLowerCase().includes(val));
        if (matches.length === 0) return;
        matches.forEach(model => {
            const div = document.createElement('div');
            div.className = 'autocomplete-item';
            div.textContent = model;
            div.addEventListener('mousedown', () => { input.value = model; list.classList.remove('show'); });
            list.appendChild(div);
        });
        list.classList.add('show');
    });

    input.addEventListener('focus', function () {
        const val = this.value.toLowerCase().trim();
        list.innerHTML = '';
        const pool = val ? MODELS.filter(m => m.toLowerCase().includes(val)) : MODELS;
        pool.forEach(model => {
            const div = document.createElement('div');
            div.className = 'autocomplete-item';
            div.textContent = model;
            div.addEventListener('mousedown', () => { input.value = model; list.classList.remove('show'); });
            list.appendChild(div);
        });
        if (pool.length) list.classList.add('show');
    });

    input.addEventListener('blur', function () {
        setTimeout(() => list.classList.remove('show'), 150);
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

    document.getElementById('sales-count').textContent = '共' + getSalesOrders().length + '单';
    const filtered = salesFilter ? getSales().filter(s => s.platform === salesFilter) : getSales();
    renderSalesList(filtered);

    // 初始化多商品行
    initSaleProductRows();
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
    const ids = new Set(list.map(s => saleOrderId(s)));
    const orders = getSalesOrders().filter(o => ids.has(o.orderId));
    const el = document.getElementById('sales-list');
    if (!orders.length) { el.innerHTML = '<div class="empty-state">No Sales Records / 暂无销售记录</div>'; return; }
    const pCls = (p) => p === '淘宝' ? 'badge-orange' : p === '抖音' ? 'badge-douyin' : 'badge-xhs';
    el.innerHTML = `<div class="table-wrap" > <table class="ref-table"><thead><tr><th>日期</th><th>平台</th><th>地区</th><th>商品</th><th>数量</th><th>收入</th><th>利润</th><th></th></tr></thead><tbody>` + orders.map(o => {
        const products = o.items.map(item => `${item.design ? item.design + ' ' : ''}${item.model}×${item.quantity}`).join('<br>');
        return `<tr><td>${o.date}</td><td><span class="badge ${pCls(o.platform)}">${o.platform}</span></td><td>${o.province || '-'}</td><td>${products}</td><td>${o.quantity}件</td><td class="success">¥${fmt(o.totalRevenue)}</td><td class="${o.profit >= 0 ? 'success' : 'danger'}">¥${fmt(o.profit)}</td><td class="td-delete" onclick="confirmDeleteSalesOrder('${o.orderId}')">✕</td></tr>`;
    }).join('') + `</tbody></table></div > `;
}
// 库存商品查找表（design+model → unitCost）
let _productMap = {};

function buildProductMap() {
    const inventory = getInventorySummary();
    _productMap = {};
    inventory.filter(i => i.stock > 0).forEach(item => {
        const k = item.design + ' - ' + item.model;
        _productMap[k] = { design: item.design, model: item.model, unitCost: item.avgCost || 0, stock: item.stock };
    });
    return _productMap;
}

function addSaleProductRow() {
    buildProductMap();
    const container = document.getElementById('s-product-rows');
    const idx = container.children.length;
    const row = document.createElement('div');
    row.className = 'sale-product-row';
    row.innerHTML = `
            <div class="sale-product-row-header" >
            <span class="sale-product-num">商品 ${idx + 1}</span>
            <button type="button" class="model-row-del" onclick="removeSaleProductRow(this)" title="删除此商品">✕</button>
        </div >
        <div class="form-row">
            <div class="form-group">
                <label class="form-label">款名 + 型号</label>
                <div class="autocomplete-wrap">
                    <input type="text" class="form-input sp-product" placeholder="输入搜索已进货的款型" autocomplete="off">
                    <div class="autocomplete-list"></div>
                </div>
            </div>
        </div>
        <div class="form-row">
            <div class="form-group third">
                <label class="form-label">数量</label>
                <input type="number" class="form-input sp-qty" value="1" min="1">
            </div>
            <div class="form-group third">
                <label class="form-label">售价(元/件)</label>
                <input type="number" class="form-input sp-price" placeholder="49.9" step="0.1">
            </div>
            <div class="form-group third">
                <label class="form-label">进货价(元/件)</label>
                <input type="number" class="form-input sp-cost" placeholder="18" step="0.1">
            </div>
        </div>
        `;
    container.appendChild(row);

    // 绑定商品自动补全
    const input = row.querySelector('.sp-product');
    const list = row.querySelector('.autocomplete-list');
    const costInput = row.querySelector('.sp-cost');
    bindProductAutocomplete(input, list, costInput);
    // 实时更新利润预览
    [row.querySelector('.sp-qty'), row.querySelector('.sp-price'), costInput].forEach(el => {
        el.addEventListener('input', updateSaleProfitPreview);
    });
}

function bindProductAutocomplete(input, list, costInput) {
    function showProducts(filter) {
        buildProductMap();
        list.innerHTML = '';
        const entries = Object.entries(_productMap);
        const matches = filter ? entries.filter(([k]) => k.toLowerCase().includes(filter.toLowerCase())) : entries;
        matches.forEach(([label, v]) => {
            const div = document.createElement('div');
            div.className = 'autocomplete-item';
            div.innerHTML = `<span > ${label}</span > <span style="color:var(--color-text-muted);font-size:11px;margin-left:8px">库存${v.stock} · 成本¥${fmt(v.unitCost)}</span>`;
            div.addEventListener('mousedown', () => {
                input.value = label;
                costInput.value = v.unitCost;
                list.classList.remove('show');
                updateSaleProfitPreview();
            });
            list.appendChild(div);
        });
        if (matches.length) list.classList.add('show'); else list.classList.remove('show');
    }

    input.addEventListener('input', function () { showProducts(this.value.trim()); updateSaleProfitPreview(); });
    input.addEventListener('focus', function () { showProducts(this.value.trim()); });
    input.addEventListener('blur', function () { setTimeout(() => list.classList.remove('show'), 150); });
}

function removeSaleProductRow(btn) {
    const container = document.getElementById('s-product-rows');
    if (container.children.length <= 1) { showToast('至少保留一件商品', true); return; }
    btn.closest('.sale-product-row').remove();
    // 更新编号
    [...container.children].forEach((row, i) => {
        row.querySelector('.sale-product-num').textContent = '商品 ' + (i + 1);
    });
    updateSaleProfitPreview();
}

function initSaleProductRows() {
    const container = document.getElementById('s-product-rows');
    if (container && container.children.length === 0) { addSaleProductRow(); }
}

function updateSaleProfitPreview() {
    const previewEl = document.getElementById('s-profit-preview');
    if (!previewEl) return;
    const rows = document.querySelectorAll('#s-product-rows .sale-product-row');
    let totalRev = 0, totalCost = 0;
    let valid = false;
    rows.forEach(row => {
        const q = Number(row.querySelector('.sp-qty')?.value) || 0;
        const spRaw = row.querySelector('.sp-price')?.value ?? '';
        const pcRaw = row.querySelector('.sp-cost')?.value ?? '';
        const sp = Number(spRaw);
        const pc = Number(pcRaw);
        if (q > 0 && spRaw !== '' && pcRaw !== '' && sp >= 0 && pc >= 0) {
            valid = true;
            totalRev += sp * q;
            totalCost += pc * q;
        }
    });
    if (!valid) { document.getElementById('s-profit-preview').style.display = 'none'; return; }

    const lo = numOrDefault(document.getElementById('s-logistics').value, 3);
    const pk = numOrDefault(document.getElementById('s-packaging').value, 3);
    const ins = numOrDefault(document.getElementById('s-insurance').value, 0);
    const commRate = Number(document.querySelector('input[name="s-commission"]:checked')?.value) || 0;
    const commAmt = totalRev * commRate;
    totalCost += lo + pk + ins + commAmt;
    const profit = totalRev - totalCost;

    document.getElementById('s-profit-preview').style.display = 'block';
    document.getElementById('sp-revenue').textContent = '+¥' + fmt(totalRev);
    document.getElementById('sp-cost').textContent = '-¥' + fmt(totalCost);
    document.getElementById('sp-profit').textContent = '¥' + fmt(profit);
    document.getElementById('sp-profit').className = 'profit-big ' + (profit >= 0 ? 'success' : 'danger');
}

function submitSale() {
    const rows = document.querySelectorAll('#s-product-rows .sale-product-row');
    const items = [];
    for (const row of rows) {
        const productVal = row.querySelector('.sp-product').value.trim();
        const quantity = row.querySelector('.sp-qty').value;
        const price = row.querySelector('.sp-price').value;
        const cost = row.querySelector('.sp-cost').value;
        if (!productVal || !quantity || price === '' || cost === '') continue;
        if (Number(quantity) <= 0) continue;
        if (Number(price) < 0) { showToast('售价不能小于0', true); return; }
        const mapped = _productMap[productVal];
        if (!mapped) { showToast('销售商品必须从库存池中选择', true); return; }
        items.push({
            design: mapped ? mapped.design : '',
            model: mapped ? mapped.model : productVal,
            quantity, sellingPrice: price, purchaseCost: cost
        });
    }
    if (items.length === 0) { showToast('请至少填写一件商品的完整信息', true); return; }
    const qtyByProduct = {};
    items.forEach(item => {
        const label = item.design + ' - ' + item.model;
        qtyByProduct[label] = (qtyByProduct[label] || 0) + Number(item.quantity);
    });
    for (const [label, qty] of Object.entries(qtyByProduct)) {
        const stock = _productMap[label]?.stock || 0;
        if (qty > stock) { showToast(`${label} 当前库存只有 ${stock} 件`, true); return; }
    }

    const date = document.getElementById('s-date').value;
    const province = document.getElementById('s-province')?.value || '';
    if (!province || !CHINA_PROVINCES.includes(province)) { showToast('请选择买家地区', true); return; }
    const note = document.getElementById('s-note').value;
    const commissionVal = document.querySelector('input[name="s-commission"]:checked')?.value || '0';
    const lo = numOrDefault(document.getElementById('s-logistics').value, 3);
    const pk = numOrDefault(document.getElementById('s-packaging').value, 3);
    const ins = numOrDefault(document.getElementById('s-insurance').value, 0);
    const orderId = genId();

    items.forEach((item, i) => {
        addSale({
            date, platform: currentPlatform,
            orderId, province,
            design: item.design, model: item.model,
            quantity: item.quantity, sellingPrice: item.sellingPrice,
            purchaseCost: item.purchaseCost,
            logistics: i === 0 ? lo : 0,
            packaging: i === 0 ? pk : 0,
            insurance: i === 0 ? ins : 0,
            commission: commissionVal,
            note: items.length > 1 ? (note ? note + ` [${i + 1}/${items.length}]` : `合单[${i + 1}/${items.length}]`) : note
        });
    });

    showToast(`已保存 ${items.length} 件商品的销售记录 ✓ 云端同步中`);
    // 重置表单
    document.getElementById('s-note').value = '';
    document.querySelector('input[name="s-commission"][value="0"]').checked = true;
    document.getElementById('s-profit-preview').style.display = 'none';
    const container = document.getElementById('s-product-rows');
    container.innerHTML = '';
    addSaleProductRow();
    toggleForm('sales');
    refreshAll();
}

function confirmDeleteSale(id) { showModal('确认删除', '确定要删除这条销售记录吗？', () => { deleteSale(id); showToast('已删除'); refreshAll(); }); }
function confirmDeleteSalesOrder(orderId) { showModal('确认删除', '确定要删除这笔销售订单吗？订单内商品明细会一起删除。', () => { deleteSalesOrder(orderId); showToast('已删除'); refreshAll(); }); }


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
    document.getElementById('returns-month-amount').textContent = '¥' + fmt(mr.reduce((s, r) => s + getReturnProfitAdjustment(r), 0));
    document.getElementById('returns-month-label').textContent = returnsMonth + '月退货';
    document.getElementById('returns-amount-label').textContent = returnsMonth + '月扣回利润';
    document.getElementById('returns-year-label').textContent = returnsYear + '年';
    document.getElementById('returns-year-title').textContent = returnsYear + '年扣回利润';
    document.getElementById('returns-year-amount').textContent = '¥' + fmt(yr.reduce((s, r) => s + getReturnProfitAdjustment(r), 0));
    document.getElementById('returns-count').textContent = '共' + allReturns.length + '条';

    renderReturnOrderPool();
    renderRegionReturnStats();

    const el = document.getElementById('returns-list');
    if (!allReturns.length) { el.innerHTML = '<div class="empty-state">No Return Records / 暂无退货记录</div>'; return; }
    allReturns.sort((a, b) => b.date.localeCompare(a.date));
    const pCls = (p) => p === '淘宝' ? 'badge-orange' : p === '抖音' ? 'badge-douyin' : 'badge-xhs';
    el.innerHTML = `<div class="table-wrap"> <table class="ref-table"><thead><tr><th>日期</th><th>平台</th><th>地区</th><th>退回商品</th><th>数量</th><th>扣回利润</th><th></th></tr></thead><tbody>` + allReturns.map(r => {
        const products = getReturnItems(r).map(item => `${item.design ? item.design + ' ' : ''}${item.model}×${item.quantity}`).join('<br>') || `${r.design || '-'} ${r.model || ''}`;
        return `<tr><td>${r.date}</td><td><span class="badge ${pCls(r.platform)}">${r.platform}</span></td><td>${r.province || '-'}</td><td>${products}</td><td>${r.quantity}件</td><td class="danger">¥${fmt(getReturnProfitAdjustment(r))}</td><td class="td-delete" onclick="confirmDeleteReturn('${r.id}')">✕</td></tr>`;
    }).join('') + `</tbody></table></div>`;
}

function renderRegionReturnStats() {
    const el = document.getElementById('return-region-table');
    if (!el) return;
    const map = {};
    getSalesOrders().forEach(order => {
        const province = order.province || '未填地区';
        if (!map[province]) map[province] = { province, saleOrders: 0, returnOrders: new Set(), soldQty: 0, returnQty: 0, returnedProfit: 0 };
        map[province].saleOrders++;
        map[province].soldQty += order.quantity;
    });
    getReturns().forEach(r => {
        const province = r.province || '未填地区';
        if (!map[province]) map[province] = { province, saleOrders: 0, returnOrders: new Set(), soldQty: 0, returnQty: 0, returnedProfit: 0 };
        if (r.orderId) map[province].returnOrders.add(r.orderId);
        else map[province].returnOrders.add(r.id);
        map[province].returnQty += Number(r.quantity) || 0;
        map[province].returnedProfit += getReturnProfitAdjustment(r);
    });
    const rows = Object.values(map)
        .filter(row => row.saleOrders > 0 || row.returnQty > 0)
        .map(row => ({
            ...row,
            returnOrderCount: row.returnOrders.size,
            orderRate: row.saleOrders > 0 ? row.returnOrders.size / row.saleOrders * 100 : 0,
            qtyRate: row.soldQty > 0 ? row.returnQty / row.soldQty * 100 : 0
        }))
        .sort((a, b) => b.orderRate - a.orderRate || b.returnOrderCount - a.returnOrderCount);
    if (!rows.length) { el.innerHTML = '<div class="empty-state-sm">暂无地区退货数据</div>'; return; }
    el.innerHTML = `<div class="table-wrap"><table class="ref-table"><thead><tr><th>地区</th><th>销售订单</th><th>退货订单</th><th>订单退货率</th><th>售出件数</th><th>退回件数</th><th>商品退货率</th><th>扣回利润</th></tr></thead><tbody>` + rows.map(row => `<tr><td>${row.province}</td><td>${row.saleOrders}</td><td>${row.returnOrderCount}</td><td class="${row.orderRate >= 20 ? 'danger' : 'success'}">${fmt(row.orderRate)}%</td><td>${row.soldQty}</td><td>${row.returnQty}</td><td>${fmt(row.qtyRate)}%</td><td class="danger">¥${fmt(row.returnedProfit)}</td></tr>`).join('') + `</tbody></table></div>`;
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

function getReturnableOrders() {
    const range = document.getElementById('r-range')?.value || '30';
    const keyword = (document.getElementById('r-order-search')?.value || '').trim().toLowerCase();
    const cutoff = range === 'all' ? null : new Date(Date.now() - Number(range) * 86400000);
    return getSalesOrders().filter(order => {
        if (returnPlatform && order.platform !== returnPlatform) return false;
        if (cutoff && new Date(order.date) < cutoff) return false;
        const returned = getReturnedQtyBySaleLine(order.orderId);
        const hasRemaining = order.items.some(item => item.quantity - (returned[item.saleId] || 0) > 0);
        if (!hasRemaining) return false;
        if (!keyword) return true;
        const haystack = [
            order.date, order.platform, order.province,
            ...order.items.map(item => `${item.design} ${item.model}`)
        ].join(' ').toLowerCase();
        return haystack.includes(keyword);
    });
}

function renderReturnOrderPool(keepSelected = true) {
    const select = document.getElementById('r-order');
    if (!select) return;
    const previous = keepSelected ? select.value : '';
    const orders = getReturnableOrders();
    select.innerHTML = '<option value="">请选择已销售订单</option>' + orders.map(order => {
        const products = order.items.map(item => `${item.design ? item.design + ' ' : ''}${item.model}×${item.quantity}`).join(' / ');
        return `<option value="${order.orderId}">${order.date} · ${order.province || '未填地区'} · ${order.platform} · ${products}</option>`;
    }).join('');
    if (previous && orders.some(o => o.orderId === previous)) select.value = previous;
    renderReturnOrderDetail();
}

function renderReturnOrderDetail() {
    const box = document.getElementById('r-order-detail');
    if (!box) return;
    const orderId = document.getElementById('r-order')?.value;
    const order = getSalesOrders().find(o => o.orderId === orderId);
    if (!order) {
        box.innerHTML = '<div class="empty-state-sm">选择一笔销售订单后，这里会显示可退商品</div>';
        return;
    }
    const returned = getReturnedQtyBySaleLine(order.orderId);
    const rows = order.items.map(item => {
        const returnedQty = returned[item.saleId] || 0;
        const remaining = Math.max(0, item.quantity - returnedQty);
        return `<div class="return-item-row" data-sale-id="${item.saleId}" data-design="${item.design}" data-model="${item.model}" data-price="${item.sellingPrice}" data-cost="${item.purchaseCost}" data-remaining="${remaining}">
            <div class="return-item-main">
                <span class="return-item-name">${item.design ? item.design + ' ' : ''}${item.model}</span>
                <span class="return-item-meta">已售${item.quantity}件 · 可退${remaining}件 · 售价¥${fmt(item.sellingPrice)}</span>
            </div>
            <input type="number" class="form-input return-qty-input" value="0" min="0" max="${remaining}">
        </div>`;
    }).join('');
    box.innerHTML = `<div class="return-order-meta">
        <span>订单地区：${order.province || '-'}</span>
        <span>订单收入：¥${fmt(order.totalRevenue)}</span>
        <span>订单利润：¥${fmt(order.profit)}</span>
    </div>${rows}`;
}

function submitReturn() {
    const orderId = document.getElementById('r-order').value;
    const order = getSalesOrders().find(o => o.orderId === orderId);
    if (!order) { showToast('请先选择一笔已销售订单', true); return; }
    const items = [];
    document.querySelectorAll('#r-order-detail .return-item-row').forEach(row => {
        const quantity = Number(row.querySelector('.return-qty-input').value) || 0;
        const remaining = Number(row.dataset.remaining) || 0;
        if (quantity <= 0) return;
        if (quantity > remaining) {
            row.querySelector('.return-qty-input').value = remaining;
            items.push({ tooMany: true });
            return;
        }
        items.push({
            saleId: row.dataset.saleId,
            design: row.dataset.design,
            model: row.dataset.model,
            quantity,
            sellingPrice: Number(row.dataset.price) || 0,
            purchaseCost: Number(row.dataset.cost) || 0
        });
    });
    if (!items.length) { showToast('请填写至少一个退回商品数量', true); return; }
    if (items.some(item => item.tooMany)) { showToast('退货数量不能超过可退数量', true); renderReturnOrderDetail(); return; }

    const returnedRevenue = items.reduce((s, item) => s + item.sellingPrice * item.quantity, 0);
    const returnedProductCost = items.reduce((s, item) => s + item.purchaseCost * item.quantity, 0);
    const usedPackagingCredit = getReturns().filter(r => r.orderId === order.orderId).reduce((s, r) => s + (Number(r.packagingCredit) || 0), 0);
    const availablePackagingCredit = Math.max(0, (Number(order.packaging) || 0) - usedPackagingCredit);
    const packagingCredit = Math.min(availablePackagingCredit, Math.max(0, returnedRevenue - returnedProductCost));
    const profitAdjustment = Math.max(0, returnedRevenue - returnedProductCost - packagingCredit);
    const logistics = Number(order.logistics) || 0;
    const insurance = Number(order.insurance) || 0;
    const lossAmount = hasReturnLossBooked(order.orderId) ? 0 : getOrderNonReusableLoss(order);

    addReturn({
        orderId: order.orderId,
        date: document.getElementById('r-date').value,
        platform: order.platform,
        province: order.province,
        design: items[0].design,
        model: items[0].model,
        items,
        logistics,
        insurance,
        lossAmount,
        returnedRevenue,
        returnedProductCost,
        packagingCredit,
        profitAdjustment,
        reason: document.getElementById('r-reason').value
    });
    showToast('退货已记录，库存已回补 ✓');
    document.getElementById('r-reason').value = '';
    document.getElementById('r-order').value = '';
    renderReturnOrderDetail();
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
    const filteredPromos = filterByDateRange(allPromos, promoRange);
    document.getElementById('promo-month-total').textContent = '¥' + fmt(monthPromos.reduce((s, p) => s + p.amount, 0));
    document.getElementById('promo-month-label').textContent = promoMonth + '月推广支出';
    document.getElementById('promo-all-total').textContent = '¥' + fmt(yearPromos.reduce((s, p) => s + p.amount, 0));
    document.getElementById('promo-year-label').textContent = promoYear + '年';
    document.getElementById('promo-year-title').textContent = promoYear + '年推广支出';
    document.getElementById('promo-count').textContent = `${getRangeLabel(promoRange)} ${filteredPromos.length}条 / 共${allPromos.length}条`;
    renderRangeFilters('promo-range-filters', 'promotion', promoRange);
    renderMonthBars('promo-month-bars', getMonthlyAmountRows(allPromos, promoYear), promoMonth, '推广支出');

    // 设置日期默认值
    const dateEl = document.getElementById('promo-date');
    if (dateEl && !dateEl.value) dateEl.value = getToday();

    const el = document.getElementById('promo-list');
    if (!filteredPromos.length) { el.innerHTML = '<div class="empty-state">No Promotion Records / 当前范围暂无推广记录</div>'; return; }
    filteredPromos.sort((a, b) => b.date.localeCompare(a.date));
    el.innerHTML = `<div class="table-wrap"> <table class="ref-table"><thead><tr><th>日期</th><th>类型</th><th>金额</th><th>备注</th><th></th></tr></thead><tbody>` + filteredPromos.map(p => `<tr><td>${p.date}</td><td><span class="badge ${p.type === '博主推广' ? 'badge-purple' : 'badge-orange'}">${p.type}</span></td><td class="danger">¥${fmt(p.amount)}</td><td>${p.note || '-'}</td><td class="td-delete" onclick="confirmDeletePromo('${p.id}')">✕</td></tr>`).join('') + `</tbody></table></div>`;
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
    const lastCheckEl = document.getElementById('inv-last-check');

    document.getElementById('inv-total-stock').textContent = totalStock + '件';
    document.getElementById('inv-total-value').textContent = '¥' + fmt(totalValue);
    document.getElementById('inv-model-count').textContent = designSet.size + '款/' + inventory.length + '号';
    if (lastCheckEl) lastCheckEl.textContent = formatInventoryTime(getInventoryLastCheckTime());
    renderInventoryInsights(inventory);

    const el = document.getElementById('inventory-list');
    if (!filtered.length) { el.innerHTML = '<div class="empty-state">No Inventory Data / ' + (search ? '没有找到匹配的款名或型号' : '暂无库存数据') + '</div>'; return; }

    const groups = {};
    filtered.forEach(item => {
        const d = item.design || '未分类';
        if (!groups[d]) groups[d] = [];
        groups[d].push(item);
    });

    el.innerHTML = Object.entries(groups).sort(compareInventoryGroups).map(([design, items]) => {
        const sortedItems = items.slice().sort(compareInventoryItems);
        return renderInventoryDesignGroup(design, sortedItems, !!search);
    }).join('');
}

function getInventoryDesignStats(inventory) {
    const map = {};
    inventory.forEach(item => {
        const rawDesign = item.design || '';
        if (!map[rawDesign]) {
            map[rawDesign] = {
                design: rawDesign,
                label: rawDesign || '未分类',
                stock: 0,
                value: 0,
                modelCount: 0,
                lastCheck: getInventoryLastCheckTime(rawDesign)
            };
        }
        map[rawDesign].stock += Number(item.stock) || 0;
        map[rawDesign].value += Number(item.stockValue) || 0;
        map[rawDesign].modelCount++;
    });
    return Object.values(map);
}

function getInventoryModelStats(inventory) {
    const map = {};
    inventory.forEach(item => {
        const model = item.model || '未命名型号';
        if (!map[model]) map[model] = { model, stock: 0, value: 0, designCount: 0 };
        map[model].stock += Number(item.stock) || 0;
        map[model].value += Number(item.stockValue) || 0;
        map[model].designCount++;
    });
    return Object.values(map).sort((a, b) => {
        if (b.stock !== a.stock) return b.stock - a.stock;
        return b.value - a.value;
    });
}

function renderInsightRankCard(title, subtitle, items, metric, unit, valueFormatter) {
    if (!items.length) {
        return `<div class="inventory-insight-card"><div class="insight-card-title">${title}</div><div class="empty-state-sm">暂无数据</div></div>`;
    }
    const top = items.slice(0, 10);
    const max = Math.max(...top.map(item => Number(item[metric]) || 0), 1);
    const total = items.reduce((s, item) => s + (Number(item[metric]) || 0), 0);
    const topTotal = top.reduce((s, item) => s + (Number(item[metric]) || 0), 0);
    const share = total ? Math.round(topTotal / total * 100) : 0;
    return `<div class="inventory-insight-card">
        <div class="insight-card-header">
            <div>
                <div class="insight-card-title">${title}</div>
                <div class="insight-card-subtitle">${subtitle} · 前10占 ${share}%</div>
            </div>
            <span class="insight-card-badge">TOP 10</span>
        </div>
        <div class="insight-rank-list">${top.map((item, idx) => {
            const value = Number(item[metric]) || 0;
            const width = Math.max(value / max * 100, value > 0 ? 3 : 0).toFixed(2);
            return `<div class="insight-rank-row">
                <div class="insight-rank-head">
                    <span class="insight-rank-name"><b>${idx + 1}</b>${escapeHtml(item.label || item.model || '-')}</span>
                    <span class="insight-rank-value">${valueFormatter ? valueFormatter(value) : value + unit}</span>
                </div>
                <div class="insight-bar-track"><div class="insight-bar-fill" style="width:${width}%"></div></div>
                <div class="insight-rank-meta">${item.modelCount ? item.modelCount + '个型号' : item.designCount ? item.designCount + '个款' : ''}</div>
            </div>`;
        }).join('')}</div>
    </div>`;
}

function renderInventoryModelCard(modelStats) {
    if (!modelStats.length) {
        return `<div class="inventory-insight-card"><div class="insight-card-title">型号库存分布</div><div class="empty-state-sm">暂无数据</div></div>`;
    }
    const top = modelStats.slice(0, 12);
    const max = Math.max(...top.map(item => item.stock), 1);
    return `<div class="inventory-insight-card">
        <div class="insight-card-header">
            <div>
                <div class="insight-card-title">型号库存分布</div>
                <div class="insight-card-subtitle">看哪些手机型号压货最多</div>
            </div>
            <span class="insight-card-badge">MODEL</span>
        </div>
        <div class="model-distribution-list">${top.map(item => {
            const width = Math.max(item.stock / max * 100, item.stock > 0 ? 3 : 0).toFixed(2);
            return `<div class="model-dist-row">
                <div class="model-dist-main">
                    <span class="model-dist-name">${escapeHtml(item.model)}</span>
                    <span class="model-dist-value">${item.stock}件</span>
                </div>
                <div class="insight-bar-track slim"><div class="insight-bar-fill green" style="width:${width}%"></div></div>
                <div class="model-dist-meta">${item.designCount}个款 · ¥${fmt(item.value)}</div>
            </div>`;
        }).join('')}</div>
    </div>`;
}

function renderInventoryCheckStatusCard(designStats) {
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    const recent = designStats.filter(item => item.lastCheck && now - item.lastCheck <= 7 * day);
    const stale = designStats.filter(item => item.lastCheck && now - item.lastCheck > 30 * day);
    const never = designStats.filter(item => !item.lastCheck);
    const needCheck = [...never, ...stale].sort((a, b) => b.value - a.value).slice(0, 5);
    return `<div class="inventory-insight-card">
        <div class="insight-card-header">
            <div>
                <div class="insight-card-title">盘点状态</div>
                <div class="insight-card-subtitle">按款名看复盘覆盖情况</div>
            </div>
            <span class="insight-card-badge">CHECK</span>
        </div>
        <div class="inventory-status-grid">
            <div class="inventory-status-tile good"><span>${recent.length}</span><em>7天内</em></div>
            <div class="inventory-status-tile warn"><span>${stale.length}</span><em>超30天</em></div>
            <div class="inventory-status-tile idle"><span>${never.length}</span><em>未盘点</em></div>
        </div>
        <div class="status-watch-list">
            ${needCheck.length ? needCheck.map(item => `<div class="status-watch-row">
                <span>${escapeHtml(item.label)}</span>
                <em>${item.lastCheck ? formatInventoryTime(item.lastCheck) : '尚未盘点'}</em>
            </div>`).join('') : '<div class="empty-state-sm">暂无需要特别关注的款</div>'}
        </div>
    </div>`;
}

function renderInventoryInsights(inventory) {
    const el = document.getElementById('inventory-insights');
    if (!el) return;
    if (!inventory.length) {
        el.innerHTML = '<div class="empty-state">暂无库存洞察</div>';
        return;
    }
    const designStats = getInventoryDesignStats(inventory);
    const byValue = designStats.slice().sort((a, b) => b.value - a.value);
    const byStock = designStats.slice().sort((a, b) => b.stock - a.stock);
    const modelStats = getInventoryModelStats(inventory);
    el.innerHTML = [
        renderInsightRankCard('积压成本 TOP 10', '钱压在哪些款上', byValue, 'value', '元', value => '¥' + fmt(value)),
        renderInsightRankCard('库存件数 TOP 10', '货压在哪些款上', byStock, 'stock', '件', value => value + '件'),
        renderInventoryModelCard(modelStats),
        renderInventoryCheckStatusCard(designStats)
    ].join('');
}

function renderInventoryDesignGroup(displayDesign, items, forceOpen = false) {
    const rawDesign = items[0]?.design || '';
    const stock = items.reduce((s, i) => s + (Number(i.stock) || 0), 0);
    const value = items.reduce((s, i) => s + (Number(i.stockValue) || 0), 0);
    const encodedDesign = encodeURIComponent(rawDesign);
    const open = forceOpen || expandedInventoryDesign === rawDesign;
    const lastCheck = formatInventoryTime(getInventoryLastCheckTime(rawDesign));
    const zeroCount = items.filter(i => (Number(i.stock) || 0) === 0).length;

    return `<div class="design-group inventory-design-group ${open ? '' : 'collapsed'}">
        <div class="design-header inventory-design-header" onclick="toggleInventoryDesign('${encodedDesign}')">
            <div class="design-header-left">
                <span class="design-arrow">▼</span>
                <span class="design-name">${escapeHtml(displayDesign)}</span>
                <span class="badge badge-purple">${items.length}个型号</span>
            </div>
            <div class="design-header-right">
                <span class="design-stat">库存 ${stock}件</span>
                <span class="design-stat danger">¥${fmt(value)}</span>
                <span class="design-stat muted">上次 ${lastCheck}</span>
            </div>
        </div>
        <div class="design-body inventory-design-panel" data-design-label="${escapeHtml(displayDesign)}">
            <div class="inventory-design-summary">
                <span>当前库存 ${stock} 件</span>
                <span>积压成本 ¥${fmt(value)}</span>
                <span>${zeroCount} 个型号为 0</span>
            </div>
            <div class="inventory-table-wrap">
                <table class="inventory-count-table">
                    <thead>
                        <tr>
                            <th>型号</th>
                            <th>当前库存</th>
                            <th>本次盘点</th>
                            <th>积压成本</th>
                        </tr>
                    </thead>
                    <tbody>${items.map(renderInventoryCountRow).join('')}</tbody>
                </table>
            </div>
            <div class="inventory-design-footer">
                <span class="inventory-pending-count">0 个型号待保存</span>
                <button class="inventory-save-btn" onclick="saveInventoryDesign('${encodedDesign}', this)" disabled>保存这个款的盘点</button>
            </div>
        </div>
    </div>`;
}

function renderInventoryCountRow(item) {
    const stock = Number(item.stock) || 0;
    const value = Number(item.stockValue) || 0;
    return `<tr class="inventory-count-row">
        <td class="inventory-model-cell">${escapeHtml(item.model || '-')}</td>
        <td><span class="inventory-stock-num">${stock}</span></td>
        <td>
            <div class="inventory-count-editor">
                <button type="button" class="inv-step-btn" onclick="changeInventoryDraft(this, -1)">-</button>
                <input type="number" class="form-input inventory-count-input" min="0" step="1" value="${stock}" data-current="${stock}" data-model="${escapeHtml(item.model || '')}" oninput="onInventoryCountInput(this)">
                <button type="button" class="inv-step-btn" onclick="changeInventoryDraft(this, 1)">+</button>
            </div>
        </td>
        <td class="danger">¥${fmt(value)}</td>
    </tr>`;
}


// ============================================
// 报表页
// ============================================

function renderReport() {
    document.getElementById('report-month').textContent = reportYear + '年' + reportMonth + '月';
    document.getElementById('rpt-year').textContent = reportYear;
    const report = getMonthlyReport(reportYear, reportMonth);
    const inv = getInventorySummary();
    const stockValue = inv.reduce((s, i) => s + i.stockValue, 0);

    const profitEl = document.getElementById('rpt-profit');
    profitEl.textContent = '¥' + fmt(report.totalOutflow);
    profitEl.className = 'profit-big-num danger';

    const rateBadge = document.getElementById('rpt-rate-badge');
    rateBadge.textContent = report.expenseCount + '笔支出';
    rateBadge.className = 'badge badge-orange';

    document.getElementById('rpt-revenue').textContent = '¥' + fmt(report.totalPurchaseSpend);
    document.getElementById('rpt-cost').textContent = '¥' + fmt(report.totalOrders);
    document.getElementById('rpt-refund-row').style.display = 'none';
    document.getElementById('rpt-supplies').textContent = '¥' + fmt(report.totalSupplies);
    document.getElementById('rpt-promo').textContent = '¥' + fmt(report.totalPromo);
    document.getElementById('rpt-orders').textContent = '¥' + fmt(report.totalSalary);

    document.getElementById('rpt-sold-qty').textContent = report.totalPurchaseQty;
    document.getElementById('rpt-return-qty').textContent = report.expenseCount;
    document.getElementById('rpt-purchase-spend').textContent = '¥' + fmt(stockValue);

    const pbEl = document.getElementById('platform-breakdown');
    renderExpenseBreakdownRows(pbEl, [
        { name: '订货转账', amount: report.totalOrders, count: report.orderCount },
        { name: '辅料支出', amount: report.totalSupplies, count: report.suppliesCount },
        { name: '推广支出', amount: report.totalPromo, count: report.promoCount },
        { name: '发工资', amount: report.totalSalary, count: report.salaryCount }
    ]);

    const fsEl = document.getElementById('factory-summary');
    const fs = getFactorySummary(reportYear);
    if (!fs.length) fsEl.innerHTML = '<div class="empty-state-sm">暂无数据</div>';
    else { const total = fs.reduce((s, f) => s + f.totalAmount, 0); fsEl.innerHTML = fs.map(f => `<div class="factory-row"><div class="factory-info"><span class="factory-name">${f.factory}</span><span class="factory-meta">${f.orders}笔 · ${f.totalQty}件</span></div><span class="factory-amount danger">¥${fmt(f.totalAmount)}</span></div>`).join('') + ` <div class="factory-total"><span class="factory-total-label">全年总计</span><span class="factory-total-value danger">¥${fmt(total)}</span></div>`; }

    renderTrendChart();

    // 年度汇总
    const yr = getYearlyReport(reportYear);
    document.getElementById('yr-year-label').textContent = reportYear;
    const yrProfitEl = document.getElementById('yr-profit');
    yrProfitEl.textContent = '¥' + fmt(yr.totalOutflow);
    yrProfitEl.className = 'profit-big-num danger';
    const yrBadge = document.getElementById('yr-rate-badge');
    yrBadge.textContent = yr.expenseCount + '笔支出';
    yrBadge.className = 'badge badge-orange';
    document.getElementById('yr-revenue').textContent = '¥' + fmt(yr.totalPurchaseSpend);
    document.getElementById('yr-cost').textContent = '¥' + fmt(yr.totalOrders);
    document.getElementById('yr-refund-row').style.display = 'none';
    document.getElementById('yr-supplies').textContent = '¥' + fmt(yr.totalSupplies);
    document.getElementById('yr-promo').textContent = '¥' + fmt(yr.totalPromo);
    document.getElementById('yr-orders').textContent = '¥' + fmt(yr.totalSalary);
    document.getElementById('yr-sold-qty').textContent = yr.totalPurchaseQty;
    document.getElementById('yr-return-qty').textContent = yr.expenseCount;
    document.getElementById('yr-purchase-spend').textContent = '¥' + fmt(stockValue);
}

function renderExpenseBreakdownRows(el, rows) {
    const total = rows.reduce((s, row) => s + (Number(row.amount) || 0), 0);
    const visible = rows.filter(row => (Number(row.amount) || 0) > 0 || (Number(row.count) || 0) > 0);
    if (!visible.length) {
        el.innerHTML = '<div class="empty-state-sm">暂无支出数据</div>';
        return;
    }
    el.innerHTML = visible.map(row => {
        const amount = Number(row.amount) || 0;
        const pct = total ? Math.round(amount / total * 1000) / 10 : 0;
        return `<div class="platform-item">
            <div class="platform-header">
                <span class="badge badge-orange">${escapeHtml(row.name)}</span>
                <span class="platform-profit danger">¥${fmt(amount)}</span>
            </div>
            <div class="platform-stats"><span>${row.count || 0}笔</span><span>占比 ${pct}%</span></div>
        </div>`;
    }).join('');
}

function getYearlyReport(year) {
    const yPrefix = String(year);
    const ys = getSales().filter(s => s.date.startsWith(yPrefix));
    const yp = getPurchases().filter(p => p.date.startsWith(yPrefix));
    const yr = getReturns().filter(r => r.date.startsWith(yPrefix));
    const ysup = getSupplies().filter(s => s.date.startsWith(yPrefix));
    const ypromo = getStore(KEYS.PROMOTIONS).filter(p => p.date && p.date.startsWith(yPrefix));
    const yorders = getStore(KEYS.ORDERS).filter(o => o.date && o.date.startsWith(yPrefix));
    const ysal = getStore(KEYS.SALARIES).filter(s => s.date && s.date.startsWith(yPrefix));

    const totalRevenue = ys.reduce((s, x) => s + x.totalRevenue, 0);
    const totalCost = ys.reduce((s, x) => s + x.totalCost, 0);
    const totalRefund = yr.reduce((s, x) => s + getReturnProfitAdjustment(x), 0);
    const totalSupplies = ysup.reduce((s, x) => s + x.amount, 0);
    const totalPromo = ypromo.reduce((s, x) => s + x.amount, 0);
    const totalOrders = yorders.reduce((s, x) => s + x.amount, 0);
    const totalSalary = ysal.reduce((s, x) => s + (Number(x.amount) || 0), 0);
    const totalPurchaseSpend = yp.reduce((s, x) => s + x.totalCost, 0);
    const totalOutflow = totalSupplies + totalPromo + totalOrders + totalSalary;
    const grossProfit = totalRevenue - totalCost - totalRefund - totalSupplies - totalPromo - totalOrders;

    return {
        totalRevenue: Math.round(totalRevenue * 100) / 100,
        totalCost: Math.round(totalCost * 100) / 100,
        totalRefund: Math.round(totalRefund * 100) / 100,
        totalSupplies: Math.round(totalSupplies * 100) / 100,
        totalPromo: Math.round(totalPromo * 100) / 100,
        totalOrders: Math.round(totalOrders * 100) / 100,
        totalSalary: Math.round(totalSalary * 100) / 100,
        totalOutflow: Math.round(totalOutflow * 100) / 100,
        grossProfit: Math.round(grossProfit * 100) / 100,
        totalSoldQty: ys.reduce((s, x) => s + x.quantity, 0),
        totalReturnQty: yr.reduce((s, x) => s + x.quantity, 0),
        totalPurchaseSpend: Math.round(totalPurchaseSpend * 100) / 100,
        totalPurchaseQty: yp.reduce((s, x) => s + (Number(x.quantity) || 0), 0),
        expenseCount: ysup.length + ypromo.length + yorders.length + ysal.length,
        purchaseCount: yp.length,
        suppliesCount: ysup.length,
        promoCount: ypromo.length,
        orderCount: yorders.length,
        salaryCount: ysal.length,
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
    const maxVal = Math.max(...trend.map(t => Math.max(t.stockIn, t.outflow)), 1);
    document.getElementById('trend-chart').innerHTML = trend.map(t => {
        const rh = Math.max(4, Math.round((t.stockIn / maxVal) * 120));
        const ph = Math.max(4, Math.round((t.outflow / maxVal) * 120));
        const rLabel = t.stockIn > 0 ? `¥${fmt(t.stockIn)} ` : '';
        const pLabel = t.outflow > 0 ? `¥${fmt(t.outflow)} ` : '';
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

function collectBackupData() {
    const data = {};
    Object.values(KEYS).forEach(key => {
        data[key] = getStore(key);
    });

    Object.keys(localStorage).forEach(key => {
        if (!key.startsWith('shell_') || data[key] !== undefined) return;
        try {
            const value = JSON.parse(localStorage.getItem(key));
            data[key] = value;
        } catch {
            data[key] = localStorage.getItem(key);
        }
    });

    return data;
}

function backupData() {
    const data = collectBackupData();
    const backup = {
        version: '4.0-migration-safe',
        exportDate: new Date().toISOString(),
        app: '壳记账',
        data,
        meta: {
            keyCount: Object.keys(data).length,
            legacySalesCount: getSales().length,
            legacyReturnsCount: getReturns().length,
            inventoryBaselineCount: getInventoryBaseline().length,
            inventoryAdjustmentCount: getInventoryAdjustments().length,
            inventoryPreview: getInventorySummary().map(item => ({
                design: item.design || '',
                model: item.model || '',
                stock: item.stock,
                avgCost: item.avgCost,
                stockValue: item.stockValue
            }))
        }
    };
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
        - allReturns.reduce((s, x) => s + getReturnProfitAdjustment(x), 0)
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

function setCostRefSearch(value) {
    costRefSearch = (value || '').trim().toLowerCase();
    renderCostRef();
}

function costRefMatches(fields) {
    if (!costRefSearch) return true;
    return fields.some(value => String(value || '').toLowerCase().includes(costRefSearch));
}

function renderCostRef() {
    const searchInput = document.getElementById('costref-search');
    if (searchInput && searchInput.value !== costRefSearch) searchInput.value = costRefSearch;

    const allShells = getShellCosts();
    const shells = allShells.filter(s => costRefMatches([s.factory, s.shell, s.specialName, s.note]));
    document.getElementById('shell-cost-count').textContent = costRefSearch ? `搜索 ${shells.length}条 / 共${allShells.length}条` : '共' + allShells.length + '条';
    const sb = document.getElementById('shell-cost-body');
    if (!shells.length) { sb.innerHTML = `<tr><td colspan="8" class="empty-state">${costRefSearch ? '没有找到匹配记录' : '暂无记录，点上方新增'}</td></tr>`; }
    else { sb.innerHTML = shells.map(s => `<tr><td>${s.factory}</td><td>${s.shell}</td><td>¥${fmt(s.magnetic)}</td><td>¥${fmt(s.nonMagnetic)}</td><td>${s.specialName || '-'}</td><td>${s.specialPrice ? '¥' + fmt(s.specialPrice) : '-'}</td><td>${s.note || '-'}</td><td><span class="td-edit" onclick="editShellCost('${s.id}')">✏️</span> <span class="td-delete" onclick="confirmDeleteShellCost('${s.id}')">✕</span></td></tr>`).join(''); }

    const allBrackets = getBracketCosts();
    const brackets = allBrackets.filter(b => costRefMatches([b.factory, b.bracket, b.specialName, b.note]));
    document.getElementById('bracket-cost-count').textContent = costRefSearch ? `搜索 ${brackets.length}条 / 共${allBrackets.length}条` : '共' + allBrackets.length + '条';
    const bb = document.getElementById('bracket-cost-body');
    if (!brackets.length) { bb.innerHTML = `<tr><td colspan="7" class="empty-state">${costRefSearch ? '没有找到匹配记录' : '暂无记录，点上方新增'}</td></tr>`; }
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


// ============================================
// 优惠券设置 / 价格策略备忘
// ============================================

let editingCouponId = null;

function getCouponSettings() { return getStore(KEYS.COUPON_SETTINGS); }

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function normalizeCouponSetting(item = {}) {
    const firstOption = Array.isArray(item.options) && item.options.length ? item.options[0] : null;
    const source = firstOption || item;
    const originalPrice = Number(source.originalPrice) || 0;
    const dailyPrice = Number(source.dailyPrice) || 0;
    const logisticsCost = numOrDefault(source.logisticsCost ?? source.logistics ?? item.logisticsCost ?? item.logistics, 3);
    const packagingCost = numOrDefault(source.packagingCost ?? source.packaging ?? item.packagingCost ?? item.packaging, 3);
    return {
        id: item.id || '',
        createdAt: item.createdAt || 0,
        updatedAt: item.updatedAt || 0,
        name: (item.name || source.name || '').trim(),
        cost: Number(source.cost) || 0,
        logisticsCost,
        packagingCost,
        originalPrice,
        dailyPrice,
        livePrice: Number(source.livePrice) || 0,
        groupPrice: Number(source.groupPrice) || 0,
        couponThreshold: originalPrice,
        couponOff: Math.max(originalPrice - dailyPrice, 0),
        commissionRate: Number(item.commissionRate ?? item.commission ?? 15) || 0,
        platformDiscount: Number(item.platformDiscount) || 88,
        note: (item.note || '').trim()
    };
}

function addCouponSetting(item) {
    const list = getCouponSettings();
    list.unshift({ ...normalizeCouponSetting(item), id: genId(), createdAt: Date.now() });
    setStore(KEYS.COUPON_SETTINGS, list);
}

function updateCouponSetting(id, item) {
    const list = getCouponSettings();
    const idx = list.findIndex(x => x.id === id);
    if (idx === -1) return;
    list[idx] = { ...normalizeCouponSetting(item), id, createdAt: list[idx].createdAt || Date.now(), updatedAt: Date.now() };
    setStore(KEYS.COUPON_SETTINGS, list);
}

function deleteCouponSetting(id) {
    setStore(KEYS.COUPON_SETTINGS, getCouponSettings().filter(x => x.id !== id));
}

function getCouponCalc(item) {
    item = normalizeCouponSetting(item);
    const baseCost = item.cost + item.logisticsCost + item.packagingCost;
    const couponPrice = Math.max(item.originalPrice - item.couponOff, 0);
    const platformPrice = item.originalPrice > 0 && item.platformDiscount > 0 ? item.originalPrice * item.platformDiscount / 100 : 0;
    const bloggerCommission = item.livePrice * item.commissionRate / 100;
    const dailyProfit = item.dailyPrice ? item.dailyPrice - baseCost : 0;
    const storeLiveProfit = item.livePrice ? item.livePrice - baseCost : 0;
    const bloggerProfit = item.livePrice ? item.livePrice - baseCost - bloggerCommission : 0;
    const groupProfit = item.groupPrice ? item.groupPrice - baseCost : 0;
    const platformProfit = platformPrice ? platformPrice - baseCost : 0;
    return {
        baseCost: Math.round(baseCost * 100) / 100,
        couponPrice: Math.round(couponPrice * 100) / 100,
        platformPrice: Math.round(platformPrice * 100) / 100,
        couponOff: Math.round(item.couponOff * 100) / 100,
        bloggerCommission: Math.round(bloggerCommission * 100) / 100,
        dailyProfit: Math.round(dailyProfit * 100) / 100,
        storeLiveProfit: Math.round(storeLiveProfit * 100) / 100,
        liveProfit: Math.round(storeLiveProfit * 100) / 100,
        bloggerProfit: Math.round(bloggerProfit * 100) / 100,
        groupProfit: Math.round(groupProfit * 100) / 100,
        platformProfit: Math.round(platformProfit * 100) / 100
    };
}

function getCouponWarnings(item) {
    item = normalizeCouponSetting(item);
    const calc = getCouponCalc(item);
    const warnings = [];
    if (item.originalPrice <= 0) warnings.push('原价未填写');
    if (item.dailyPrice <= 0) warnings.push('日常价未填写');
    if (item.originalPrice && item.dailyPrice && item.originalPrice <= item.dailyPrice) warnings.push('原价需要高于日常价，才有满减空间');
    if (calc.platformPrice) {
        if (item.groupPrice && calc.platformPrice <= item.groupPrice) warnings.push('平台活动价不高于群内购');
        if (item.livePrice && calc.platformPrice <= item.livePrice) warnings.push('平台活动价不高于直播价');
        if (item.dailyPrice && calc.platformPrice >= item.dailyPrice) warnings.push('平台活动价不低于日常价');
    }
    [
        ['日常价', calc.dailyProfit, item.dailyPrice],
        ['店播', calc.storeLiveProfit, item.livePrice],
        ['博主直播间', calc.bloggerProfit, item.livePrice],
        ['群内购', calc.groupProfit, item.groupPrice],
        ['平台活动', calc.platformProfit, calc.platformPrice]
    ].forEach(([label, profit, price]) => {
        if (!price) return;
        if (profit <= 0) warnings.push(`${label}毛利为负或为0`);
        else if (profit / price < 0.2) warnings.push(`${label}毛利率低于20%`);
    });
    return warnings;
}

function readCouponForm() {
    return {
        name: document.getElementById('cp-name').value,
        cost: document.getElementById('cp-cost').value,
        logisticsCost: document.getElementById('cp-logistics').value,
        packagingCost: document.getElementById('cp-packaging').value,
        originalPrice: document.getElementById('cp-original').value,
        dailyPrice: document.getElementById('cp-daily').value,
        livePrice: document.getElementById('cp-live').value,
        groupPrice: document.getElementById('cp-group').value,
        commissionRate: document.getElementById('cp-commission').value,
        platformDiscount: document.getElementById('cp-platform-discount').value,
        note: document.getElementById('cp-note').value
    };
}

function setCouponCommission(rate) {
    document.getElementById('cp-commission').value = rate;
    document.querySelectorAll('.coupon-commission-chip').forEach(btn => btn.classList.toggle('active', btn.textContent.trim() === rate + '%'));
    updateCouponPreview();
}

function setCouponDiscount(rate) {
    document.getElementById('cp-platform-discount').value = rate;
    document.querySelectorAll('.coupon-discount-chip').forEach(btn => btn.classList.toggle('active', btn.textContent.trim() === rate + '折'));
    updateCouponPreview();
}

function syncCouponRateButtons(item) {
    document.querySelectorAll('.coupon-commission-chip').forEach(btn => btn.classList.toggle('active', btn.textContent.trim() === item.commissionRate + '%'));
    document.querySelectorAll('.coupon-discount-chip').forEach(btn => btn.classList.toggle('active', btn.textContent.trim() === item.platformDiscount + '折'));
}

function renderProfitValue(profit, price) {
    const rate = price ? Math.round(profit / price * 1000) / 10 : 0;
    const cls = profit >= 0 ? 'success' : 'danger';
    return `<b class="${cls}">¥${fmt(profit)}</b><em>毛利率 ${rate}%</em>`;
}

function updateCouponPreview() {
    const box = document.getElementById('coupon-preview');
    if (!box) return;
    const item = normalizeCouponSetting(readCouponForm());
    const calc = getCouponCalc(item);
    const warnings = getCouponWarnings(item).filter(w => w !== '原价未填写' && w !== '日常价未填写');
    syncCouponRateButtons(item);
    box.innerHTML = `
        <div class="coupon-preview-card coupon-coupon-card">
            <span>推荐店铺券</span>
            <b>满${Math.round(item.originalPrice || 0)}减${Math.round(calc.couponOff || 0)}</b>
            <em>券后价 ¥${fmt(calc.couponPrice)} / 合计成本 ¥${fmt(calc.baseCost)}</em>
        </div>
        <div class="coupon-preview-card">
            <span>日常价毛利</span>
            ${renderProfitValue(calc.dailyProfit, item.dailyPrice)}
        </div>
        <div class="coupon-preview-card">
            <span>店播毛利</span>
            ${renderProfitValue(calc.storeLiveProfit, item.livePrice)}
        </div>
        <div class="coupon-preview-card">
            <span>博主直播间毛利</span>
            ${renderProfitValue(calc.bloggerProfit, item.livePrice)}
            <em>佣金 ¥${fmt(calc.bloggerCommission)} (${item.commissionRate}%)</em>
        </div>
        <div class="coupon-preview-card">
            <span>群内购毛利</span>
            ${renderProfitValue(calc.groupProfit, item.groupPrice)}
        </div>
        <div class="coupon-preview-card">
            <span>平台活动毛利</span>
            ${renderProfitValue(calc.platformProfit, calc.platformPrice)}
            <em>${item.platformDiscount}折后 ¥${fmt(calc.platformPrice)}</em>
        </div>
        <div class="coupon-preview-card ${warnings.length ? 'warning' : ''}">
            <span>价格检查</span>
            <b>${warnings.length ? warnings.length + '项' : '通过'}</b>
            <em>${warnings[0] || '价格层级和毛利正常'}</em>
        </div>
    `;
}

function resetCouponForm() {
    editingCouponId = null;
    ['cp-name', 'cp-cost', 'cp-original', 'cp-daily', 'cp-live', 'cp-group', 'cp-note'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });
    document.getElementById('cp-logistics').value = '3';
    document.getElementById('cp-packaging').value = '3';
    document.getElementById('cp-commission').value = '15';
    document.getElementById('cp-platform-discount').value = '88';
    const btn = document.querySelector('#coupon-form .btn-primary');
    if (btn) btn.textContent = 'SAVE CALC / 保存测算';
    updateCouponPreview();
}

function submitCouponSetting() {
    const data = normalizeCouponSetting(readCouponForm());
    if (!data.name || !data.cost || !data.originalPrice || !data.dailyPrice || !data.livePrice || !data.groupPrice) {
        showToast('请填写商品、成本、原价、日常价、直播价和群内购', true);
        return;
    }
    if (editingCouponId) {
        updateCouponSetting(editingCouponId, data);
        showToast('优惠券测算已更新 ✓');
    } else {
        addCouponSetting(data);
        showToast('优惠券测算已保存 ✓');
    }
    resetCouponForm();
    toggleForm('coupon');
    renderCoupons();
}

function editCouponSetting(id) {
    const raw = getCouponSettings().find(x => x.id === id);
    if (!raw) return;
    const item = normalizeCouponSetting(raw);
    editingCouponId = id;
    document.getElementById('cp-name').value = item.name || '';
    document.getElementById('cp-cost').value = item.cost || '';
    document.getElementById('cp-logistics').value = item.logisticsCost;
    document.getElementById('cp-packaging').value = item.packagingCost;
    document.getElementById('cp-original').value = item.originalPrice || '';
    document.getElementById('cp-daily').value = item.dailyPrice || '';
    document.getElementById('cp-live').value = item.livePrice || '';
    document.getElementById('cp-group').value = item.groupPrice || '';
    document.getElementById('cp-commission').value = item.commissionRate || 15;
    document.getElementById('cp-platform-discount').value = item.platformDiscount || 88;
    document.getElementById('cp-note').value = item.note || '';
    document.getElementById('coupon-form').style.display = 'block';
    document.getElementById('coupon-arrow').textContent = '▲';
    document.querySelector('#coupon-form .btn-primary').textContent = 'UPDATE CALC / 更新测算';
    updateCouponPreview();
    document.getElementById('coupon-form').scrollIntoView({ behavior: 'smooth' });
}

function confirmDeleteCouponSetting(id) {
    showModal('确认删除', '删除这条优惠券价格方案？', () => {
        deleteCouponSetting(id);
        showToast('已删除');
        renderCoupons();
    });
}

function renderCoupons() {
    const list = getCouponSettings().map(normalizeCouponSetting);
    const warningCount = list.filter(item => getCouponWarnings(item).length > 0).length;
    const profitValues = list.flatMap(item => {
        const calc = getCouponCalc(item);
        return [
            item.dailyPrice ? calc.dailyProfit : null,
            item.livePrice ? calc.storeLiveProfit : null,
            item.livePrice ? calc.bloggerProfit : null,
            item.groupPrice ? calc.groupProfit : null,
            calc.platformPrice ? calc.platformProfit : null
        ].filter(v => v !== null);
    });
    document.getElementById('coupon-total-count').textContent = list.length + '个';
    document.getElementById('coupon-warning-count').textContent = warningCount + '个';
    document.getElementById('coupon-min-group').textContent = '¥' + fmt(profitValues.length ? Math.min(...profitValues) : 0);
    document.getElementById('coupon-list-count').textContent = '共' + list.length + '条';
    updateCouponPreview();

    const el = document.getElementById('coupon-list');
    if (!list.length) {
        el.innerHTML = '<div class="empty-state">No Calculations / 暂无测算记录</div>';
        return;
    }
    el.innerHTML = `<div class="table-wrap"><table class="ref-table coupon-table">
        <thead><tr><th>商品</th><th>推荐店铺券</th><th>日常毛利</th><th>店播毛利</th><th>博主毛利</th><th>群内购毛利</th><th>平台活动毛利</th><th>检查</th><th></th></tr></thead>
        <tbody>${list.map(item => {
        const calc = getCouponCalc(item);
        const warnings = getCouponWarnings(item);
        return `<tr>
            <td><b>${escapeHtml(item.name)}</b><div class="table-note">合计成本 ¥${fmt(calc.baseCost)}（商品 ¥${fmt(item.cost)} / 物流 ¥${fmt(item.logisticsCost)} / 包装 ¥${fmt(item.packagingCost)}）${item.note ? ' / ' + escapeHtml(item.note) : ''}</div></td>
            <td><b>满${Math.round(item.originalPrice)}减${Math.round(calc.couponOff)}</b><div class="table-note">日常价 ¥${fmt(item.dailyPrice)}</div></td>
            <td>${profitTableCell(calc.dailyProfit, item.dailyPrice)}</td>
            <td>${profitTableCell(calc.storeLiveProfit, item.livePrice)}</td>
            <td>${profitTableCell(calc.bloggerProfit, item.livePrice)}<div class="table-note">佣金 ${item.commissionRate}% / ¥${fmt(calc.bloggerCommission)}</div></td>
            <td>${profitTableCell(calc.groupProfit, item.groupPrice)}</td>
            <td>${profitTableCell(calc.platformProfit, calc.platformPrice)}<div class="table-note">${item.platformDiscount}折 / ¥${fmt(calc.platformPrice)}</div></td>
            <td>${warnings.length ? `<span class="badge badge-orange">${warnings.length}项</span><div class="table-note">${escapeHtml(warnings[0])}</div>` : '<span class="badge badge-green">OK</span>'}</td>
            <td><span class="td-edit" onclick="editCouponSetting('${item.id}')">✏️</span> <span class="td-delete" onclick="confirmDeleteCouponSetting('${item.id}')">✕</span></td>
        </tr>`;
    }).join('')}</tbody></table></div>`;
}

function profitTableCell(profit, price) {
    const cls = profit >= 0 ? 'success' : 'danger';
    const rate = price ? Math.round(profit / price * 1000) / 10 : 0;
    return `<span class="${cls}">¥${fmt(profit)}</span><div class="table-note">${rate}%</div>`;
}
