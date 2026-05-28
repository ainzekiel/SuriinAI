/**
 * expert-resolved.js — Read-only resolved case history.
 */

'use strict';

/**
 * formatReporterID — Anonymize user UID to #USR-<FIRST_6_CHARS>
 */
function formatReporterID(uid) {
  if (!uid) return '#USR-UNKNOWN';
  const first6 = String(uid).substring(0, 6).toUpperCase();
  return `#USR-${first6}`;
}

/**
 * formatDateForTimeline — Format date for resolution history timeline
 * Returns: MM/DD/YYYY<br>HH:MM AM/PM
 */
function formatDateForTimeline(isoString) {
  if (!isoString) return '—';
  try {
    const d = new Date(isoString);
    // Format: MM/DD/YYYY with leading zeros
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const year = d.getFullYear();
    const date = `${month}/${day}/${year}`;
    // Time on next line: HH:MM AM/PM
    const time = d.toLocaleTimeString('en-US', { 
      hour: '2-digit', 
      minute: '2-digit',
      hour12: true 
    });
    return `${date}<br>${time}`;
  } catch {
    return isoString;
  }
}

/**
 * showDashboardToast — page-level toast using #toast-container.
 */
function showDashboardToast(message, type = 'info') {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    container.style.cssText = `
      position: fixed;
      top: 20px;
      right: 20px;
      z-index: 9999;
      display: flex;
      flex-direction: column;
      gap: 8px;
    `;
    document.body.appendChild(container);
  }

  const toast = document.createElement('div');
  const bgColor = type === 'success' ? '#22c55e' : type === 'error' ? '#ef4444' : '#6C63FF';
  toast.style.cssText = `
    background: ${bgColor};
    color: white;
    padding: 12px 20px;
    border-radius: 8px;
    font-size: 14px;
    font-weight: 500;
    box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    opacity: 0;
    transform: translateX(100%);
    transition: all 0.3s ease;
    max-width: 400px;
    word-wrap: break-word;
  `;
  toast.textContent = message;

  container.appendChild(toast);

  // Animate in
  requestAnimationFrame(() => {
    toast.style.opacity = '1';
    toast.style.transform = 'translateX(0)';
  });

  // Remove after 3 seconds
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(100%)';
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

/**
 * showModalToast — shows toast in modal footer if available, else falls back to dashboard toast
 */
function showModalToast(message, type = 'info') {
  const footer = document.querySelector('#review-modal .modal-footer');
  if (footer) {
    const existingToast = footer.querySelector('.modal-toast');
    if (existingToast) existingToast.remove();

    const toast = document.createElement('div');
    const bgColor = type === 'success' ? '#22c55e' : type === 'error' ? '#ef4444' : '#6C63FF';
    toast.className = 'modal-toast';
    toast.style.cssText = `
      position: absolute;
      bottom: calc(100% + 8px);
      left: 50%;
      transform: translateX(-50%);
      background: ${bgColor};
      color: white;
      padding: 10px 16px;
      border-radius: 6px;
      font-size: 13px;
      font-weight: 500;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
      white-space: nowrap;
      z-index: 10;
    `;
    toast.textContent = message;

    footer.style.position = 'relative';
    footer.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transition = 'opacity 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }, 3000);
    return;
  }
  showDashboardToast(message, type);
}

let resolvedReports = [];
let resolvedCurrentPage = 1;
const resolvedPerPage = 10;
const currentArchiveTab = 'resolved';
let resolvedSortMode = 'newest';
let resolvedVerdictFilter = 'all';

window.addEventListener('suriin:auth-ready', (e) => {
  const { role } = e.detail;

  if (role !== 'expert') {
    window.location.href = getRoleHome(role);
    return;
  }

  ensureOverlayHidden();
  setupModal();
  setupResolvedFilters();
  loadResolvedReports();
});

async function loadResolvedReports() {
  const db = window.__suriinFirestore;
  const auth = window.__suriinAuth;

  if (!db) {
    console.error('[SuriinAI Expert] Firestore not available.');
    return;
  }

  try {
    // Load Resolved + legacy Reviewed reports (backward compat)
    let resolvedSnapshot, legacySnapshot;

    try {
      resolvedSnapshot = await db.collection('Reports')
        .where('status', 'in', ['Resolved', 'Reviewed'])
        .get();
    } catch (queryErr) {
      console.warn('[SuriinAI Expert] Status query failed, using fallback:', queryErr);

      const fallbackSnapshot = await db.collection('Reports').get();
      const allReports = fallbackSnapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
      resolvedReports = allReports.filter((r) => r.status === 'Resolved' || r.status === 'Reviewed');
      resolvedReports.sort((a, b) => toMillis(b.resolvedAt || b.reviewedAt || b.created_at) - toMillis(a.resolvedAt || a.reviewedAt || a.created_at));
      renderResolvedTable();
      return;
    }

    resolvedReports = resolvedSnapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    resolvedReports.sort((a, b) => toMillis(b.resolvedAt || b.reviewedAt || b.created_at) - toMillis(a.resolvedAt || a.reviewedAt || a.created_at));

    renderResolvedTable();
  } catch (err) {
    console.error('[SuriinAI Expert] Failed to load resolved reports:', err);
    showDashboardToast('Unable to load resolved cases. Check Firestore permissions.', 'error');
  }
}

function setupResolvedFilters() {
  const sortSel = document.getElementById('filter-resolved-sort');
  const verdictSel = document.getElementById('filter-resolved-verdict');
  if (sortSel) {
    sortSel.addEventListener('change', () => {
      resolvedSortMode = sortSel.value;
      resolvedCurrentPage = 1;
      renderResolvedTable();
    });
  }
  if (verdictSel) {
    verdictSel.addEventListener('change', () => {
      resolvedVerdictFilter = verdictSel.value;
      resolvedCurrentPage = 1;
      renderResolvedTable();
    });
  }
}

function renderResolutionHistory(_entries) {
}

function renderResolvedTable() {
  const tbody = document.getElementById('resolved-tbody');
  const emptyState = document.getElementById('resolved-empty');
  const countEl = document.getElementById('resolved-count');
  const table = document.getElementById('resolved-table');
  const thResolvedAt = document.getElementById('th-resolved-at');
  const thResolvedBy = document.getElementById('th-resolved-by');

  if (!tbody) return;

  // Apply verdict filter
  let currentReports = resolvedReports.filter(r => {
    if (resolvedVerdictFilter === 'all') return true;
    const v = String(r.expert_verdict || r.expertVerdict || '').trim().toLowerCase();
    if (resolvedVerdictFilter === 'safe') return v === 'safe' || v === 'verified safe';
    if (resolvedVerdictFilter === 'threat') return v === 'confirmed threat' || v === 'scam';
    return true;
  });

  // Apply sort
  currentReports = [...currentReports].sort((a, b) => {
    const ta = toMillis(a.resolvedAt || a.reviewedAt || a.created_at);
    const tb = toMillis(b.resolvedAt || b.reviewedAt || b.created_at);
    return resolvedSortMode === 'oldest' ? ta - tb : tb - ta;
  });
  if (thResolvedAt) thResolvedAt.textContent = 'Resolved At';
  if (thResolvedBy) thResolvedBy.textContent = 'Resolved by';

  tbody.innerHTML = '';
  if (countEl) countEl.textContent = `${currentReports.length} case${currentReports.length !== 1 ? 's' : ''}`;

  if (!currentReports.length) {
    if (table) table.style.display = 'none';
    if (emptyState) emptyState.style.display = '';
    const paginationContainer = document.getElementById('resolved-pagination');
    if (paginationContainer) paginationContainer.style.display = 'none';
    return;
  }

  if (table) table.style.display = '';
  if (emptyState) emptyState.style.display = 'none';

  // ── Pagination Logic ───────────────────────────────────────────────────
  const totalPages = Math.ceil(currentReports.length / resolvedPerPage);
  if (resolvedCurrentPage > totalPages) resolvedCurrentPage = totalPages;
  if (resolvedCurrentPage < 1) resolvedCurrentPage = 1;

  const startIndex = (resolvedCurrentPage - 1) * resolvedPerPage;
  const paginatedReports = currentReports.slice(startIndex, startIndex + resolvedPerPage);

  // Update Pagination UI
  const paginationContainer = document.getElementById('resolved-pagination');
  const btnPrev = document.getElementById('resolved-pagination-prev');
  const btnNext = document.getElementById('resolved-pagination-next');
  const pageNumbersContainer = document.getElementById('resolved-pagination-numbers');

  if (paginationContainer) {
    paginationContainer.style.display = totalPages > 1 ? 'flex' : 'none';

    // Show/hide Previous button (hidden on page 1)
    if (btnPrev) btnPrev.style.display = resolvedCurrentPage > 1 ? 'inline-flex' : 'none';

    // Show/hide Next button (hidden on last page)
    if (btnNext) btnNext.style.display = resolvedCurrentPage < totalPages ? 'inline-flex' : 'none';

    // Generate page number buttons
    if (pageNumbersContainer) {
      pageNumbersContainer.innerHTML = '';
      for (let i = 1; i <= totalPages; i++) {
        const pageBtn = document.createElement('button');
        pageBtn.className = 'btn btn--sm';
        pageBtn.textContent = i;
        pageBtn.style.minWidth = '32px';
        pageBtn.style.padding = '4px 8px';
        pageBtn.style.borderRadius = '4px';
        pageBtn.style.fontSize = 'var(--font-xs)';
        pageBtn.style.fontWeight = '500';

        if (i === resolvedCurrentPage) {
          // Active page styling
          pageBtn.style.background = 'var(--clr-accent, #6C63FF)';
          pageBtn.style.color = '#fff';
          pageBtn.style.border = '1px solid var(--clr-accent, #6C63FF)';
        } else {
          // Inactive page styling
          pageBtn.style.background = 'transparent';
          pageBtn.style.color = 'var(--clr-text-secondary)';
          pageBtn.style.border = '1px solid var(--clr-border)';
          pageBtn.style.cursor = 'pointer';
          pageBtn.addEventListener('click', () => {
            resolvedCurrentPage = i;
            renderResolvedTable();
          });
        }
        pageNumbersContainer.appendChild(pageBtn);
      }
    }
  }

  paginatedReports.forEach((report) => {
    const tr = document.createElement('tr');
    tr.className = 'table-row-hover';
    tr.style.cursor = 'pointer';
    // Use different modal based on tab
    tr.onclick = () => openReviewModal(report.id, 'resolved');

    const platformDomain = extractPlatform(report.url);
    const verdictText = report.expert_verdict || report.expertVerdict || '';
    const verdictPill = buildVerdictPillFromText(verdictText);
    const factorsHtml = buildRiskFactorPills(report);

    const ts = report.resolvedAt || report.reviewedAt || report.updated_at || report.created_at;
    const dateHtml = formatDateTwoLine(ts);

    const byText = computeResolvedOrDismissedBy(report, false);

    const factorsTitle = buildRiskFactorsTitleText(report);
    tr.innerHTML = `
      <td style="white-space: normal; line-height: 1.3;">${dateHtml}</td>
      <td style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${escapeHtml(byText)}">${escapeHtml(byText)}</td>
      <td class="clamp-2 wrap-anywhere" title="${escapeHtml(platformDomain)}">${escapeHtml(platformDomain)}</td>
      <td>${verdictPill}</td>
      <td class="clamp-2 wrap-anywhere" title="${escapeHtml(factorsTitle)}">${factorsHtml}</td>
      <td class="text-preview" style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${escapeHtml(formatReporterID(report.user_id || ''))}">${escapeHtml(formatReporterID(report.user_id || ''))}</td>
    `;

    tbody.appendChild(tr);
  });
}

function normalizeRisk(score) {
  const n = Number(score || 0);
  if (Number.isNaN(n)) return 0;
  return n > 1 ? Math.min(1, n / 100) : Math.max(0, n);
}

function extractPlatform(url) {
  if (!url) return '—';
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, '');
    return hostname;
  } catch {
    return '—';
  }
}

/**
 * Helper: Get platform name from URL
 */
function getPlatformName(url) {
  if (!url) return 'Unknown';
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
    const domainMap = {
      'facebook.com': 'Facebook',
      'fb.com': 'Facebook',
      'instagram.com': 'Instagram',
      'twitter.com': 'Twitter',
      'x.com': 'Twitter',
      'linkedin.com': 'LinkedIn',
      'youtube.com': 'YouTube',
      'tiktok.com': 'TikTok',
      'reddit.com': 'Reddit',
      'discord.com': 'Discord',
      'discord.gg': 'Discord',
      'telegram.org': 'Telegram',
      't.me': 'Telegram',
      'whatsapp.com': 'WhatsApp',
      'wechat.com': 'WeChat',
      'snapchat.com': 'Snapchat',
      'pinterest.com': 'Pinterest',
      'tumblr.com': 'Tumblr',
      'twitch.tv': 'Twitch',
      'kick.com': 'Kick',
      'roblox.com': 'Roblox',
      'steamcommunity.com': 'Steam',
      'epicgames.com': 'Epic Games',
      'battle.net': 'Battle.net',
      'ea.com': 'EA',
      'ubisoft.com': 'Ubisoft',
      'playstation.com': 'PlayStation',
      'xbox.com': 'Xbox',
      'nintendo.com': 'Nintendo',
      'ebay.com': 'eBay',
      'amazon.com': 'Amazon',
      'aliexpress.com': 'AliExpress',
      'alibaba.com': 'Alibaba',
      'walmart.com': 'Walmart',
      'target.com': 'Target',
      'bestbuy.com': 'Best Buy',
      'shopify.com': 'Shopify',
      'etsy.com': 'Etsy',
      'craigslist.org': 'Craigslist',
      'olx.com': 'OLX',
      'gumtree.com': 'Gumtree',
      'leboncoin.fr': 'Leboncoin',
      'marktplaats.nl': 'Marktplaats',
      'willhaben.at': 'Willhaben',
      'subito.it': 'Subito',
      'vinted.com': 'Vinted',
      'depop.com': 'Depop',
      'poshmark.com': 'Poshmark',
      'grailed.com': 'Grailed',
      'mercari.com': 'Mercari',
      'offerup.com': 'OfferUp',
      'letgo.com': 'Letgo',
      'carousell.com': 'Carousell',
      'shopee.com': 'Shopee',
      'lazada.com': 'Lazada',
      'tokopedia.com': 'Tokopedia',
      'bukalapak.com': 'Bukalapak',
      'jd.com': 'JD.com',
      'taobao.com': 'Taobao',
      'temu.com': 'Temu',
      'shein.com': 'SHEIN',
      'zalando.com': 'Zalando',
      'asos.com': 'ASOS',
      'zara.com': 'Zara',
      'h&m.com': 'H&M',
      'uniqlo.com': 'Uniqlo',
      'nike.com': 'Nike',
      'adidas.com': 'Adidas',
      'apple.com': 'Apple',
      'samsung.com': 'Samsung',
      'huawei.com': 'Huawei',
      'xiaomi.com': 'Xiaomi',
      'oppo.com': 'OPPO',
      'vivo.com': 'vivo',
      'oneplus.com': 'OnePlus',
      'realme.com': 'realme',
      'asus.com': 'ASUS',
      'acer.com': 'Acer',
      'dell.com': 'Dell',
      'hp.com': 'HP',
      'lenovo.com': 'Lenovo',
      'msi.com': 'MSI',
      'razer.com': 'Razer',
      'logitech.com': 'Logitech',
      'corsair.com': 'Corsair',
      'coolermaster.com': 'Cooler Master',
      'nzxt.com': 'NZXT',
      'evga.com': 'EVGA',
      'gigabyte.com': 'Gigabyte',
      'msi.com': 'MSI',
      'asrock.com': 'ASRock',
      'biostar.com': 'BIOSTAR',
      'pny.com': 'PNY',
      'zotac.com': 'ZOTAC',
      'palit.com': 'Palit',
      'inno3d.com': 'Inno3D',
      'gainward.com': 'Gainward',
      'sapphiretech.com': 'Sapphire',
      'xfxforce.com': 'XFX',
      'powercolor.com': 'PowerColor',
      'hisdigital.com': 'HIS',
      'visiontek.com': 'VisionTek',
      'club3d.com': 'Club 3D',
      'matrox.com': 'Matrox',
      'amd.com': 'AMD',
      'intel.com': 'Intel',
      'nvidia.com': 'NVIDIA',
      'qualcomm.com': 'Qualcomm',
      'mediatek.com': 'MediaTek',
      'broadcom.com': 'Broadcom',
      'texasinstruments.com': 'Texas Instruments',
      'micron.com': 'Micron',
      'skhynix.com': 'SK Hynix',
      'samsungsemiconductor.com': 'Samsung Semiconductor',
      'kioxia.com': 'Kioxia',
      'wd.com': 'Western Digital',
      'seagate.com': 'Seagate',
      'toshiba-storage.com': 'Toshiba',
      'sandisk.com': 'SanDisk',
      'lexar.com': 'Lexar',
      'adata.com': 'ADATA',
      'g.skill.com': 'G.SKILL',
      'corsair.com': 'Corsair',
      'teamgroupinc.com': 'TEAMGROUP',
      'patriotmemory.com': 'Patriot',
      'crucial.com': 'Crucial',
      'kingston.com': 'Kingston',
      'silicon-power.com': 'Silicon Power',
      'transcend-info.com': 'Transcend',
      'pioneer.com': 'Pioneer',
      'liteon.com': 'Lite-On',
      'asus.com': 'ASUS',
      'msi.com': 'MSI',
      'gigabyte.com': 'Gigabyte',
      'asrock.com': 'ASRock',
      'biostar.com': 'BIOSTAR',
      'evga.com': 'EVGA'
    };
    
    for (const [domain, name] of Object.entries(domainMap)) {
      if (hostname.includes(domain)) return name;
    }
    return hostname.split('.')[0].charAt(0).toUpperCase() + hostname.split('.')[0].slice(1);
  } catch {
    return 'Unknown';
  }
}

/**
 * Helper: Get platform icon emoji
 */
function getPlatformIcon(platformName) {
  const iconMap = {
    'Facebook': '📘',
    'Instagram': '📷',
    'Twitter': '🐦',
    'LinkedIn': '💼',
    'YouTube': '▶️',
    'TikTok': '🎵',
    'Reddit': '🔴',
    'Discord': '💬',
    'Telegram': '✈️',
    'WhatsApp': '💚',
    'WeChat': '💬',
    'Snapchat': '👻',
    'Pinterest': '📌',
    'Tumblr': '🔵',
    'Twitch': '📺',
    'Kick': '🎮',
    'Roblox': '🧱',
    'Steam': '🎮',
    'Epic Games': '🎮',
    'Battle.net': '⚔️',
    'EA': '🎮',
    'Ubisoft': '🎮',
    'PlayStation': '🎮',
    'Xbox': '🎮',
    'Nintendo': '🎮',
    'eBay': '🛒',
    'Amazon': '📦',
    'AliExpress': '📦',
    'Alibaba': '📦',
    'Walmart': '🏪',
    'Target': '🎯',
    'Best Buy': '💻',
    'Shopify': '🛍️',
    'Etsy': '🎨',
    'Craigslist': '📰',
    'OLX': '📰',
    'Gumtree': '🌳',
    'Leboncoin': '🇫🇷',
    'Marktplaats': '🇳🇱',
    'Willhaben': '🇦🇹',
    'Subito': '🇮🇹',
    'Vinted': '👕',
    'Depop': '👕',
    'Poshmark': '👕',
    'Grailed': '👕',
    'Mercari': '🛒',
    'OfferUp': '🤝',
    'Letgo': '👋',
    'Carousell': '📱',
    'Shopee': '🍊',
    'Lazada': '💙',
    'Tokopedia': '🟢',
    'Bukalapak': '🔴',
    'JD.com': '🔴',
    'Taobao': '🟠',
    'Temu': '🟠',
    'SHEIN': '👗',
    'Zalando': '👟',
    'ASOS': '👕',
    'Zara': '👗',
    'H&M': '👕',
    'Uniqlo': '👕',
    'Nike': '👟',
    'Adidas': '👟',
    'Apple': '🍎',
    'Samsung': '📱',
    'Huawei': '📱',
    'Xiaomi': '📱',
    'OPPO': '📱',
    'vivo': '📱',
    'OnePlus': '📱',
    'realme': '📱',
    'ASUS': '💻',
    'Acer': '💻',
    'Dell': '💻',
    'HP': '💻',
    'Lenovo': '💻',
    'MSI': '🎮',
    'Razer': '🐍',
    'Logitech': '🖱️',
    'Corsair': '⚓',
    'Cooler Master': '❄️',
    'NZXT': '🖥️',
    'EVGA': '🔌',
    'Gigabyte': '💻',
    'ASRock': '🖥️',
    'BIOSTAR': '🖥️',
    'PNY': '💾',
    'ZOTAC': '🎮',
    'Palit': '🎮',
    'Inno3D': '🎮',
    'Gainward': '🎮',
    'Sapphire': '💎',
    'XFX': '⚡',
    'PowerColor': '🌈',
    'HIS': '🎮',
    'VisionTek': '👁️',
    'Club 3D': '🎮',
    'Matrox': '🖥️',
    'AMD': '🔴',
    'Intel': '🔵',
    'NVIDIA': '🟢',
    'Qualcomm': '📱',
    'MediaTek': '📱',
    'Broadcom': '📡',
    'Texas Instruments': '📟',
    'Micron': '💾',
    'SK Hynix': '💾',
    'Samsung Semiconductor': '💾',
    'Kioxia': '💾',
    'Western Digital': '💾',
    'Seagate': '💾',
    'Toshiba': '💾',
    'SanDisk': '💾',
    'Lexar': '💾',
    'ADATA': '💾',
    'G.SKILL': '💾',
    'TEAMGROUP': '💾',
    'Patriot': '🇺🇸',
    'Crucial': '💾',
    'Kingston': '💾',
    'Silicon Power': '💾',
    'Transcend': '💾',
    'Pioneer': '💿',
    'Lite-On': '💿'
  };
  return iconMap[platformName] || '🔗';
}

/**
 * Helper: Check if URL is a root domain
 */
function isRootDomainUrl(url) {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    // Check if pathname is empty or just /
    const pathname = parsed.pathname;
    return pathname === '/' || pathname === '';
  } catch {
    return false;
  }
}

function formatDate(isoString) {
  if (!isoString) return '—';
  try {
    const d = new Date(isoString);
    return d.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  } catch {
    return isoString;
  }
}

function toMillis(value) {
  const date = new Date(value || 0);
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

// Two-line date helper: first line = date, second line = time (no seconds)
function formatDateParts(isoString) {
  if (!isoString) return { date: '—', time: '' };
  try {
    const d = new Date(isoString);
    const date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const time = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    return { date, time };
  } catch {
    return { date: String(isoString), time: '' };
  }
}

function formatDateTwoLine(isoString) {
  const parts = formatDateParts(isoString);
  return `
    <div>${escapeHtml(parts.date)}</div>
    <div style="color: var(--clr-text-muted); font-size: var(--font-xs);">${escapeHtml(parts.time)}</div>
  `;
}

function buildVerdictPillFromText(verdictText) {
  const v = String(verdictText || '').trim().toLowerCase();
  if (!v) return '<span class="badge">—</span>';
  if (v === 'safe' || v === 'verified safe') {
    return '<span class="badge" style="background: rgba(34,197,94,0.15); color:#22c55e; border:1px solid rgba(34,197,94,0.35);">Verified Safe</span>';
  }
  if (v === 'confirmed threat' || v === 'scam' || v === 'threat') {
    return '<span class="badge" style="background: rgba(239,68,68,0.15); color:#ef4444; border:1px solid rgba(239,68,68,0.35);">Confirmed Threat</span>';
  }
  if (v === 'invalid' || v === 'false positive' || v === 'noise') {
    return '<span class="badge" style="background: rgba(148,163,184,0.15); color:#94a3b8; border:1px solid rgba(148,163,184,0.35);">Invalid</span>';
  }
  return `<span class="badge">${escapeHtml(verdictText)}</span>`;
}

function computeResolvedOrDismissedBy(report, isDismissed) {
  const email = report.reviewedByEmail || report.reviewed_by_email || '';
  if (email) return '@' + String(email).split('@')[0];
  // Fallback: scan resolutionHistory
  const hist = Array.isArray(report.resolutionHistory) ? report.resolutionHistory : [];
  const target = isDismissed ? 'Dismissed' : 'Reviewed';
  for (let i = hist.length - 1; i >= 0; i--) {
    const entry = hist[i] || {};
    if (String(entry.status) === target && entry.assigned_email) {
      return '@' + String(entry.assigned_email).split('@')[0];
    }
  }
  // Final fallback: anonymize UID
  const uid = report.reviewedBy || report.reviewed_by || '';
  return uid ? ('@' + String(uid).slice(0, 6)) : '—';
}

function buildRiskFactorHtml(report) {
  const rows = [];
  if (report.matched_company) {
    rows.push(
      `<div class="risk-factor-row">` +
      `<span class="risk-factor-badge risk-factor-badge--watchlist">SEC Watchlist</span>` +
      `<span class="risk-factor-value">${escapeHtml(String(report.matched_company))}</span>` +
      `</div>`
    );
  }
  if (Array.isArray(report.trigger_tokens) && report.trigger_tokens.length) {
    const tokens = report.trigger_tokens.filter(Boolean);
    if (tokens.length) {
      rows.push(
        `<div class="risk-factor-row">` +
        `<span class="risk-factor-badge risk-factor-badge--ai">AI Flagged</span>` +
        `<span class="risk-factor-value">${escapeHtml(tokens.join(', '))}</span>` +
        `</div>`
      );
    }
  }
  if (!rows.length) {
    const aiVerdict = String(report.ai_verdict || '').toUpperCase();
    const aiConf = report.ai_confidence ? `${Math.round(report.ai_confidence * 100)}%` : null;
    if (aiVerdict === 'WARNING' || aiVerdict === 'SUSPICIOUS' || aiVerdict === 'CRITICAL') {
      const detail = aiConf ? `Suspicious Pattern (${aiConf})` : 'Suspicious Pattern';
      rows.push(
        `<div class="risk-factor-row">` +
        `<span class="risk-factor-badge risk-factor-badge--ai">AI Flagged</span>` +
        `<span class="risk-factor-value">${escapeHtml(detail)}</span>` +
        `</div>`
      );
    } else if (report.heuristics || report.risk_factors) {
      rows.push(`<div class="risk-factor-row"><span class="risk-factor-value">${escapeHtml(report.heuristics || report.risk_factors)}</span></div>`);
    }
  }
  if (!rows.length) return 'No risk factors provided.';
  return `<div class="risk-factor-list">${rows.join('')}</div>`;
}

function buildRiskFactorPills(report) {
  let arr = [];

  if (report.matched_company) arr.push('SEC Watchlist');
  if (Array.isArray(report.trigger_tokens) && report.trigger_tokens.length) {
    arr.push('AI Flagged');
  }
  if (!arr.length) {
    const raw = report.risk_factors || report.riskFactors || report.heuristics || report.factors || '';
    if (Array.isArray(raw)) arr = raw.slice();
    else if (typeof raw === 'string' && raw.trim()) {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) arr = parsed;
        else arr = raw.split(/[,;|]/).map(s => s.trim()).filter(Boolean);
      } catch (_) {
        arr = raw.split(/[,;|]/).map(s => s.trim()).filter(Boolean);
      }
    }
  }

  if (!arr.length) return '<span class="text-muted">No factors</span>';

  const visible = arr.slice(0, 2).map((f) => `<span class="pill" title="${escapeHtml(f)}">${escapeHtml(f)}</span>`).join('');
  const remaining = arr.length - 2;
  if (remaining > 0) {
    const moreList = arr.slice(2).join(', ');
    return `${visible}<span class="pill pill--more" title="${escapeHtml(moreList)}">+${remaining} more</span>`;
  }

  return visible;
}

function buildRiskFactorsTitleText(report) {
  const raw = report.risk_factors || report.riskFactors || report.heuristics || report.factors || '';
  let arr = [];
  if (Array.isArray(raw)) arr = raw.slice();
  else if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) arr = parsed;
      else arr = raw.split(/[,;|]/).map(s => s.trim()).filter(Boolean);
    } catch (_) {
      arr = raw.split(/[,;|]/).map(s => s.trim()).filter(Boolean);
    }
  }
  return arr.join(', ');
}

function getRoleHome(role) {
  if (role === 'admin') return '/admin-dashboard';
  if (role === 'expert') return '/expert-dashboard';
  return '/user-dashboard';
}

function ensureOverlayHidden() {
  const overlay = document.getElementById('loading-overlay');
  if (overlay) overlay.classList.add('hidden');
}

function escapeHtml(input) {
  return String(input || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function buildThreatBadge(score) {
  const pct = Math.round(score * 100);
  let label = 'Safe';
  let cls = 'risk-score-badge--safe';

  if (pct >= 70) {
    label = 'Critical';
    cls = 'risk-score-badge--critical';
  } else if (pct >= 40) {
    label = 'Warning';
    cls = 'risk-score-badge--warning';
  }

  return `<span class="badge ${cls}" title="Threat level: ${label}">${label} (${pct}%)</span>`;
}

function openReviewModal(reportId, mode = 'resolved') {
  const isDismissed = false;
  const report = resolvedReports.find((item) => item.id === reportId);
  if (!report) return;

  selectedReportId = reportId;

  // Header elements
  const titleEl = document.getElementById('review-modal-title');
  const reportedByEl = document.getElementById('modal-reported-by');
  const resolvedByEl = document.getElementById('modal-resolved-by');
  const dismissedByEl = document.getElementById('modal-dismissed-by');
  const resolvedAtEl = document.getElementById('modal-resolved-at');
  const auditLabelEl = document.getElementById('modal-audit-label');
  const auditTrailResolved = document.getElementById('modal-audit-trail-resolved');
  const auditTrailDismissed = document.getElementById('modal-audit-trail-dismissed');
  const statusBadgeResolved = document.getElementById('modal-status-badge-resolved');
  const finalVerdictBadgeEl = document.getElementById('modal-final-verdict-badge');
  const finalVerdictDisplayEl = document.getElementById('modal-final-verdict-display');
  const notesLabelEl = document.getElementById('modal-notes-label');
  const remWrapperEl = document.getElementById('modal-remediation-wrapper');
  const safetyWrapperEl = document.getElementById('modal-safety-wrapper');
  const reopenBtn = document.getElementById('reopen-case-btn');

  // ── Dismissed vs Resolved mode toggles ───────────────────────────────────
  if (auditTrailResolved) auditTrailResolved.style.display = isDismissed ? 'none' : '';
  if (auditTrailDismissed) auditTrailDismissed.style.display = isDismissed ? '' : 'none';
  if (auditLabelEl) auditLabelEl.textContent = isDismissed ? 'On' : 'Resolved at';

  // Dismissed status badge (gray)
  if (statusBadgeResolved) {
    if (isDismissed) {
      statusBadgeResolved.textContent = 'Dismissed';
      statusBadgeResolved.style.background = 'rgba(156,163,175,0.15)';
      statusBadgeResolved.style.color = '#9ca3af';
      statusBadgeResolved.style.border = '1px solid rgba(156,163,175,0.3)';
      statusBadgeResolved.style.display = '';
    } else {
      statusBadgeResolved.style.display = 'none';
    }
  }

  // Notes section label
  if (notesLabelEl) notesLabelEl.textContent = isDismissed ? 'Reason for Dismissal' : 'Expert Notes';

  // Hide verdict, remediation, safety, reopen for dismissed
  if (finalVerdictDisplayEl) finalVerdictDisplayEl.parentElement.style.display = isDismissed ? 'none' : '';
  if (remWrapperEl && isDismissed) remWrapperEl.style.display = 'none';
  if (safetyWrapperEl && isDismissed) safetyWrapperEl.style.display = 'none';
  if (reopenBtn) reopenBtn.style.display = isDismissed ? 'none' : '';

  // Platform & Source elements
  const platformNameEl = document.getElementById('modal-platform-name');
  const sourceIdentifierEl = document.getElementById('modal-source-identifier');
  const userContextSectionEl = document.getElementById('modal-user-context-section');
  const userContextEl = document.getElementById('modal-user-context');

  // AI Analysis elements
  const riskThreatEl = document.getElementById('modal-risk-threat');
  const factorsEl = document.getElementById('modal-risk-factors');
  const evidenceEl = document.getElementById('modal-raw-evidence');
  const imageWrapper = document.getElementById('modal-image-wrapper');
  const imageEl = document.getElementById('modal-image');

  // Expert Notes, Verdict, Remediation
  const notesEl = document.getElementById('modal-expert-notes-display');
  const verdictBadgeEl = document.getElementById('modal-verdict-badge');
  const remWrapper = document.getElementById('modal-remediation-wrapper');
  const remDisplay = document.getElementById('modal-remediation-display');
  const safetyWrapper = document.getElementById('modal-safety-wrapper');
  const safetyDisplay = document.getElementById('modal-safety-display');

  const riskPercent = Math.round(normalizeRisk(report.risk_score) * 100);
  const evidenceLink = String(report.url || report.link || '').trim();
  const imageSource = String(report.imageUrl || report.image_url || '').trim();

  // ── Header Info ────────────────────────────────────────────────────────────
  if (titleEl) titleEl.textContent = `#${reportId.toUpperCase()}`;

  // Reported by (anonymized)
  if (reportedByEl) {
    const reporterUID = report.user_id || 'unknown';
    reportedByEl.textContent = formatReporterID(reporterUID);
  }

  // Audit trail: Resolved by / Dismissed by
  const expertEmail = report.reviewedByEmail || report.reviewed_by_email || 'Expert';
  const expertHandle = '@' + expertEmail.split('@')[0];
  if (isDismissed) {
    if (dismissedByEl) dismissedByEl.textContent = expertHandle;
    if (resolvedAtEl) resolvedAtEl.textContent = formatDate(report.resolvedAt || report.dismissedAt || report.reviewedAt || report.updated_at || report.created_at);
  } else {
    if (resolvedByEl) {
      const name = expertEmail.split('@')[0];
      resolvedByEl.textContent = name.charAt(0).toUpperCase() + name.slice(1);
    }
    if (resolvedAtEl) resolvedAtEl.textContent = formatDate(report.resolvedAt || report.reviewedAt || report.updated_at || report.created_at);
  }

  // ── Platform & Source ────────────────────────────────────────────────────
  const platformName = report.platform || getPlatformName(report.url);
  const sourceIdentifier = report.source_identifier || 'Unknown suspect';
  const userContext = report.user_context;

  if (platformNameEl) platformNameEl.textContent = platformName;
  if (sourceIdentifierEl) sourceIdentifierEl.textContent = sourceIdentifier;

  // Display user context section only if it has content
  if (userContextSectionEl) {
    if (userContext) {
      if (userContextEl) userContextEl.textContent = userContext;
      userContextSectionEl.style.display = '';
    } else {
      userContextSectionEl.style.display = 'none';
    }
  }

  // ── AI Analysis ────────────────────────────────────────────────────────────
  // Risk Threat badge (replaces risk score)
  if (riskThreatEl) {
    const threatHtml = buildThreatBadge(normalizeRisk(report.risk_score));
    riskThreatEl.innerHTML = threatHtml;
  }

  if (factorsEl) factorsEl.innerHTML = buildRiskFactorHtml(report);
  if (evidenceEl) evidenceEl.textContent = report.evidence || report.text || 'No raw evidence provided.';

  // ── AI Confidence ────────────────────────────────────────────
  const aiConfEl = document.getElementById('modal-ai-confidence');
  if (aiConfEl) {
    const rawConf = typeof report.ai_confidence === 'number' ? report.ai_confidence : (report.risk_score ? Math.min(report.risk_score, 1) : 0);
    const confPct = Math.round(rawConf * 100);
    const confLabel = confPct >= 40 ? `${confPct}% Scam Probability` : `${confPct}% Safe`;
    const confColor = confPct >= 85 ? '#ef4444' : confPct >= 40 ? '#fb923c' : '#22c55e';
    aiConfEl.textContent = confLabel;
    aiConfEl.style.color = confColor;
  }

  if (imageWrapper && imageEl) {
    if (imageSource) {
      imageEl.src = imageSource;
      imageWrapper.style.display = '';
    } else {
      imageEl.removeAttribute('src');
      imageWrapper.style.display = 'none';
    }
  }

  // ── Final Verdict (read-only single badge) ─────────────────────────────────
  const verdict = report.expert_verdict || report.expertVerdict || report.status || 'Safe';
  let badgeCls = 'badge--safe';
  let badgeStyle = '';
  if (verdict === 'Confirmed Threat') {
    badgeStyle = 'background: rgba(239,68,68,0.15); color: #ef4444; border: 1px solid rgba(239,68,68,0.3);';
  } else if (verdict === 'Critical') {
    badgeCls = 'badge--critical';
  } else if (verdict === 'Warning') {
    badgeCls = 'badge--warning';
  } else if (verdict === 'Resolved') {
    badgeCls = 'badge--resolved';
  }

  if (verdictBadgeEl) {
    verdictBadgeEl.className = `badge ${badgeCls}`;
    verdictBadgeEl.textContent = verdict;
    if (badgeStyle) verdictBadgeEl.setAttribute('style', badgeStyle);
    else verdictBadgeEl.removeAttribute('style');
  }
  if (finalVerdictBadgeEl) {
    finalVerdictBadgeEl.innerHTML = badgeStyle
      ? `<span class="badge" style="${badgeStyle}">${escapeHtml(verdict)}</span>`
      : `<span class="badge ${badgeCls}">${escapeHtml(verdict)}</span>`;
  }

  // ── Expert Notes / Reason for Dismissal ──────────────────────────────────
  if (notesEl) {
    const notes = isDismissed
      ? (report.dismissalNotes || report.expert_notes || report.expertNotes)
      : (report.expert_notes || report.expertNotes);
    const placeholder = isDismissed ? 'No reason provided.' : 'No notes available.';
    if (notes) {
      notesEl.textContent = notes;
      notesEl.style.color = 'var(--clr-text-primary)';
    } else {
      notesEl.innerHTML = `<p class="text-muted" style="margin: 0; color: var(--clr-text-muted);">${placeholder}</p>`;
      notesEl.style.color = 'var(--clr-text-muted)';
    }
  }

  // ── Remediation Plan (Confirmed Threat) & Safety Justification (Safe) ────
  if (!isDismissed) {
    // Remediation Plan
    if (remWrapper && remDisplay) {
      const remPlan = report.remediationPlan || report.remediation_plan;
      if (remPlan && verdict === 'Confirmed Threat') {
        remDisplay.textContent = remPlan;
        remWrapper.style.display = '';
      } else {
        remWrapper.style.display = 'none';
      }
    }

    // Safety Justification
    if (safetyWrapper && safetyDisplay) {
      const safety = report.safety_justification || report.safetyJustification || '';
      if (safety && (verdict === 'Safe' || verdict === 'Verified Safe')) {
        safetyDisplay.textContent = safety;
        safetyWrapper.style.display = '';
      } else {
        safetyWrapper.style.display = 'none';
      }
    }
  }

  const overlay = document.getElementById('review-modal-overlay');
  if (overlay) {
    overlay.style.display = 'flex';
    document.body.style.overflow = 'hidden';
  }
}

function closeReviewModalUI() {
  const overlay = document.getElementById('review-modal-overlay');
  if (overlay) {
    overlay.style.display = 'none';
    document.body.style.overflow = '';
  }
}

function setupModal() {
  const overlay   = document.getElementById('review-modal-overlay');
  const closeBtn  = document.getElementById('review-modal-close-btn');
  const cancelBtn = document.getElementById('review-modal-cancel-btn');

  if (closeBtn)  closeBtn.addEventListener('click', closeReviewModalUI);
  if (cancelBtn) cancelBtn.addEventListener('click', closeReviewModalUI);
  if (overlay) {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeReviewModalUI();
    });
  }

  // ── Tab (Resolved only) ────────────────────────────────────────────────────
  const tabResolved = document.getElementById('tab-resolved');
  const tabDismissed = document.getElementById('tab-dismissed');
  if (tabDismissed) tabDismissed.style.display = 'none';

  if (tabResolved) {
    tabResolved.style.color = 'var(--clr-accent)';
    tabResolved.style.borderBottomColor = 'var(--clr-accent)';
    tabResolved.classList.add('active');
  }

  // ── Pagination Button Listeners ───────────────────────────────────────────
  const btnPrev = document.getElementById('resolved-pagination-prev');
  const btnNext = document.getElementById('resolved-pagination-next');

  if (btnPrev) {
    btnPrev.addEventListener('click', () => {
      if (resolvedCurrentPage > 1) {
        resolvedCurrentPage--;
        renderResolvedTable();
      }
    });
  }

  if (btnNext) {
    btnNext.addEventListener('click', () => {
      resolvedCurrentPage++;
      renderResolvedTable();
    });
  }
}

let selectedReportId = null;

