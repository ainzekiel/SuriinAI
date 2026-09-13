/* ─────────────────────────────────────────────────────────────────────────────
   admin-intelligence.js — Threat Intelligence & Training Data management
   Handles SEC watchlist display, training corpus viewing, and JSONL export.
   ───────────────────────────────────────────────────────────────────────────── */

let currentTab = 'sec-watchlist';
let secWatchlistData = [];
let corpusData = [];
let secCurrentPage = 1;
let corpusCurrentPage = 1;
const secPerPage = 25; // Increased from 10 to reduce pagination requests
const corpusPerPage = 10;

// SEC pagination state for cursor-based navigation with enhanced caching
let secPaginationState = {
  hasMore: false,
  nextCursor: null,
  totalCount: null,
  isLoading: false,
  loadedChunks: new Map(), // cursor -> data
  allDataLoaded: false,
  searchCache: new Map(), // query -> results cache
  prefetchQueue: [], // chunks to prefetch
  lastActivity: Date.now()
};

// Debounce timers for performance optimization
let searchDebounceTimer = null;
let paginationDebounceTimer = null;

// ── Initialization ───────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  initTabs();
  initSearch();
  initExportButton();
  initPagination();

  // Check if auth is already ready (event may have fired before we loaded)
  if (window.__suriinAuthReady && window.__suriinAuthData) {
    console.log('[Admin Intelligence] Auth already ready, initializing...');
    handleAuthReady(window.__suriinAuthData);
  }

  // Failsafe: show page after 3 seconds even if auth hasn't fired
  setTimeout(() => {
    const dashboardWrapper = document.getElementById('dashboard-wrapper');
    if (dashboardWrapper && dashboardWrapper.style.display === 'none') {
      console.log('[Admin Intelligence] Failsafe timeout - showing page');
      const loadingOverlay = document.getElementById('loading-overlay');
      if (loadingOverlay) loadingOverlay.classList.add('hidden');
      dashboardWrapper.style.display = 'block';
    }
  }, 3000);
});

// Auth ready listener
window.addEventListener('suriin:auth-ready', async (e) => {
  console.log('[Admin Intelligence] Auth ready event received');
  const { user, role } = e.detail;
  await handleAuthReady({ user, role });
});

async function handleAuthReady(authData) {
  const { user, role } = authData;
  console.log('[Admin Intelligence] handleAuthReady called, role:', role, 'user:', !!user);

  // Hide loading overlay and show dashboard
  const loadingOverlay = document.getElementById('loading-overlay');
  const dashboardWrapper = document.getElementById('dashboard-wrapper');

  console.log('[Admin Intelligence] Loading overlay:', loadingOverlay, 'Dashboard:', dashboardWrapper);

  if (loadingOverlay) {
    loadingOverlay.classList.add('hidden');
    console.log('[Admin Intelligence] Loading overlay hidden');
  }
  if (dashboardWrapper) {
    dashboardWrapper.style.display = 'block';
    console.log('[Admin Intelligence] Dashboard shown');
  }

  // Verify admin role
  if (role !== 'admin') {
    console.log('[Admin Intelligence] Not admin, redirecting...');
    window.location.href = '/admin-dashboard';
    return;
  }

  if (user) {
    console.log('[Admin Intelligence] User authenticated, loading data...');
    document.getElementById('user-email').textContent = user.email || '';
    try {
      await loadSecWatchlist();
      console.log('[Admin Intelligence] SEC watchlist loaded');
    } catch (e) {
      console.error('[Admin Intelligence] SEC watchlist error:', e);
    }
    try {
      await loadTrainingCorpus();
      console.log('[Admin Intelligence] Training corpus loaded');
    } catch (e) {
      console.error('[Admin Intelligence] Training corpus error:', e);
    }
  } else {
    console.log('[Admin Intelligence] No user, skipping data load');
  }
}

// ── Enhanced Caching Functions ──────────────────────────────────────────────────

function saveToSessionStorage() {
  // Save pagination state and cached chunks to sessionStorage for persistence
  try {
    const stateToSave = {
      secPaginationState: {
        hasMore: secPaginationState.hasMore,
        nextCursor: secPaginationState.nextCursor,
        totalCount: secPaginationState.totalCount,
        loadedChunks: Array.from(secPaginationState.loadedChunks.entries()),
        allDataLoaded: secPaginationState.allDataLoaded,
        searchCache: Array.from(secPaginationState.searchCache.entries())
      },
      secCurrentPage,
      secWatchlistData: secWatchlistData.slice(0, 100) // Limit saved data size
    };
    sessionStorage.setItem('adminIntelligenceCache', JSON.stringify(stateToSave));
    console.log('[Admin Intelligence] Saved state to sessionStorage');
  } catch (e) {
    console.warn('[Admin Intelligence] Failed to save to sessionStorage:', e);
  }
}

function loadFromSessionStorage() {
  // Restore pagination state from sessionStorage
  try {
    const savedState = sessionStorage.getItem('adminIntelligenceCache');
    if (savedState) {
      const state = JSON.parse(savedState);
      if (state.secPaginationState) {
        secPaginationState.hasMore = state.secPaginationState.hasMore;
        secPaginationState.nextCursor = state.secPaginationState.nextCursor;
        secPaginationState.totalCount = state.secPaginationState.totalCount;
        secPaginationState.loadedChunks = new Map(state.secPaginationState.loadedChunks || []);
        secPaginationState.allDataLoaded = state.secPaginationState.allDataLoaded;
        secPaginationState.searchCache = new Map(state.secPaginationState.searchCache || []);
      }
      secCurrentPage = state.secCurrentPage || 1;
      if (state.secWatchlistData) {
        secWatchlistData = state.secWatchlistData;
      }
      console.log('[Admin Intelligence] Restored state from sessionStorage');
      return true;
    }
  } catch (e) {
    console.warn('[Admin Intelligence] Failed to load from sessionStorage:', e);
  }
  return false;
}

function prefetchNextChunk() {
  // Prefetch the next chunk during user idle time
  if (secPaginationState.nextCursor && !secPaginationState.isLoading && !secPaginationState.allDataLoaded) {
    const idleCallback = (deadline) => {
      if (deadline.timeRemaining() > 50 && secPaginationState.nextCursor) {
        console.log('[Admin Intelligence] Prefetching next chunk');
        loadSECChunk(secPaginationState.nextCursor, true).catch(e => {
          console.warn('[Admin Intelligence] Prefetch failed:', e);
        });
      }
    };
    
    if ('requestIdleCallback' in window) {
      requestIdleCallback(idleCallback);
    }
  }
}

// ── Pagination ────────────────────────────────────────────────────────────────

function initPagination() {
  // SEC pagination event listeners
  const secBtnPrev = document.getElementById('sec-pagination-prev');
  const secBtnNext = document.getElementById('sec-pagination-next');

  if (secBtnPrev) {
    secBtnPrev.addEventListener('click', () => {
      if (secPaginationState.isLoading) return;
      
      // Debounce rapid pagination requests
      clearTimeout(paginationDebounceTimer);
      paginationDebounceTimer = setTimeout(async () => {
        secPaginationState.lastActivity = Date.now();
        if (secCurrentPage > 1) {
          secCurrentPage--;
          await loadPreviousPage();
          saveToSessionStorage();
        }
      }, 100);
    });
  }

  if (secBtnNext) {
    secBtnNext.addEventListener('click', () => {
      if (secPaginationState.isLoading || !secPaginationState.hasMore) return;
      
      // Debounce rapid pagination requests
      clearTimeout(paginationDebounceTimer);
      paginationDebounceTimer = setTimeout(async () => {
        secPaginationState.lastActivity = Date.now();
        secCurrentPage++;
        await loadNextPage();
        saveToSessionStorage();
        // Trigger prefetch after successful load
        setTimeout(prefetchNextChunk, 500);
      }, 100);
    });
  }

  // Corpus pagination event listeners
  const corpusBtnPrev = document.getElementById('corpus-pagination-prev');
  const corpusBtnNext = document.getElementById('corpus-pagination-next');

  if (corpusBtnPrev) {
    corpusBtnPrev.addEventListener('click', () => {
      if (corpusCurrentPage > 1) {
        corpusCurrentPage--;
        renderCorpusTable();
      }
    });
  }

  if (corpusBtnNext) {
    corpusBtnNext.addEventListener('click', () => {
      corpusCurrentPage++;
      renderCorpusTable();
    });
  }
}

// ── Tab Switching ──────────────────────────────────────────────────────────────

function initTabs() {
  const tabSec = document.getElementById('tab-sec');
  const tabWhitelist = document.getElementById('tab-whitelist');
  const tabCorpus = document.getElementById('tab-corpus');
  const secSection = document.getElementById('sec-section');
  const whitelistSection = document.getElementById('whitelist-section');
  const corpusSection = document.getElementById('corpus-section');

  if (tabSec) {
    tabSec.addEventListener('click', () => {
      currentTab = 'sec-watchlist';
      tabSec.classList.add('user-tab--active');
      if (tabWhitelist) tabWhitelist.classList.remove('user-tab--active');
      if (tabCorpus) tabCorpus.classList.remove('user-tab--active');
      if (secSection) secSection.style.display = 'block';
      if (whitelistSection) whitelistSection.style.display = 'none';
      if (corpusSection) corpusSection.style.display = 'none';
    });
  }

  if (tabWhitelist) {
    tabWhitelist.addEventListener('click', async () => {
      currentTab = 'sec-whitelist';
      tabWhitelist.classList.add('user-tab--active');
      if (tabSec) tabSec.classList.remove('user-tab--active');
      if (tabCorpus) tabCorpus.classList.remove('user-tab--active');
      if (whitelistSection) whitelistSection.style.display = 'block';
      if (secSection) secSection.style.display = 'none';
      if (corpusSection) corpusSection.style.display = 'none';

      if (!whitelistDataLoaded) {
        await loadSecWhitelist();
      }
    });
  }

  if (tabCorpus) {
    tabCorpus.addEventListener('click', () => {
      currentTab = 'training-corpus';
      tabCorpus.classList.add('user-tab--active');
      if (tabSec) tabSec.classList.remove('user-tab--active');
      if (tabWhitelist) tabWhitelist.classList.remove('user-tab--active');
      if (corpusSection) corpusSection.style.display = 'block';
      if (secSection) secSection.style.display = 'none';
      if (whitelistSection) whitelistSection.style.display = 'none';
    });
  }
}

// ── SEC Watchlist ─────────────────────────────────────────────────────────────

// Auth state listener utility
async function waitForAuthReady(maxWait = 5000) {
  const startTime = Date.now();
  while (!window.__suriinAuthReady && (Date.now() - startTime) < maxWait) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return window.__suriinAuthReady;
}

// Centralized authenticated request wrapper
async function makeAuthenticatedRequest(url, options = {}) {
  // Wait for auth to be ready
  const authReady = await waitForAuthReady();
  if (!authReady) {
    throw new Error('Authentication not ready after timeout');
  }
  
  if (!window.__suriinAuth?.user) {
    throw new Error('User not authenticated');
  }
  
  try {
    const token = await window.__suriinAuth.user.getIdToken();
    const headers = {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...options.headers
    };
    
    return fetch(url, { ...options, headers });
  } catch (error) {
    console.error('[Admin Intelligence] Token retrieval failed:', error);
    throw new Error('Failed to get authentication token');
  }
}

async function debugSecWatchlist() {
  console.log('[Admin Intelligence] DEBUG: Checking Firestore collection status...');
  
  try {
    const response = await makeAuthenticatedRequest('/api/admin/sec-watchlist-debug');

    if (response.ok) {
      // Safe JSON parsing with fallback
      const data = await response.json().catch(err => {
        console.error('[Admin Intelligence] DEBUG: JSON parsing failed:', err);
        return { success: false, debug_info: { sample_docs: [], total_docs_in_collection: 0 } };
      });
      
      console.log('[Admin Intelligence] DEBUG: Firestore collection info:', data);
      
      // Safe data extraction with fallbacks
      const debugInfo = data?.debug_info || {};
      const sampleDocs = Array.isArray(debugInfo?.sample_docs) ? debugInfo.sample_docs : [];
      const totalDocs = debugInfo?.total_docs_in_collection || 0;
      
      // Comprehensive logging for debugging
      console.log('[Admin Intelligence] DEBUG: Data structure validation:', {
        hasData: !!data,
        hasDebugInfo: !!debugInfo,
        hasSampleDocs: sampleDocs.length > 0,
        sampleDocsCount: sampleDocs.length,
        totalDocsCount: totalDocs,
        dataType: typeof data,
        debugInfoType: typeof debugInfo
      });
      
      // Log detailed debug information
      if (data?.success) {
        console.log('[Admin Intelligence] DEBUG: Total documents:', totalDocs);
        console.log('[Admin Intelligence] DEBUG: Sample documents:', sampleDocs);
        
        // Safe array processing with length validation
        if (sampleDocs.length > 0) {
          const sampleDoc = sampleDocs[0];
          const docData = sampleDoc?.data || {};
          
          console.log('[Admin Intelligence] DEBUG: Sample doc structure:', {
            id: sampleDoc?.id || 'unknown',
            has_company_name: !!docData?.company_name,
            has_category: !!docData?.category,
            has_date_cached: !!docData?.date_cached,
            has_source_url: !!docData?.source_url
          });
        } else {
          console.log('[Admin Intelligence] DEBUG: No sample documents available - empty array or undefined');
        }
      } else {
        console.log('[Admin Intelligence] DEBUG: API response indicates failure:', data?.error || 'Unknown error');
      }
      
      return data;
    } else {
      console.error('[Admin Intelligence] DEBUG: Debug endpoint failed:', response.status);
      if (response.status === 401) {
        console.error('[Admin Intelligence] DEBUG: Authentication failed for debug endpoint');
      }
    }
  } catch (err) {
    console.error('[Admin Intelligence] DEBUG: Debug endpoint error:', err);
    if (err.message.includes('Authentication')) {
      console.error('[Admin Intelligence] DEBUG: Authentication error - user may not be logged in');
    }
    
    // Return safe fallback data to prevent downstream errors
    return {
      success: false,
      debug_info: {
        sample_docs: [],
        total_docs_in_collection: 0
      },
      error: err.message
    };
  }
}

async function loadSecWatchlistChunk(cursor = null, limit = 25) {
  console.log('[Admin Intelligence] loadSecWatchlistChunk starting...', { cursor, limit });
  
  // Performance monitoring
  const startTime = performance.now();
  
  try {
    // Build query parameters
    const params = new URLSearchParams({ limit: limit.toString() });
    if (cursor) {
      params.append('cursor', cursor);
    }
    
    const response = await makeAuthenticatedRequest(`/api/admin/sec-watchlist?${params}`);

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[Admin Intelligence] SEC HTTP error:', response.status, errorText);
      
      // Handle specific authentication errors
      if (response.status === 401) {
        console.error('[Admin Intelligence] Authentication failed - token may be expired');
        showToast('Authentication failed. Please refresh the page.', 'error');
        throw new Error('Authentication failed');
      }
      
      throw new Error(`HTTP ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    const endTime = performance.now();
    const loadTime = endTime - startTime;
    
    console.log('[Admin Intelligence] SEC chunk response:', data);
    console.log('[Admin Intelligence] Response structure:', {
      success: data.success,
      watchlist: data.watchlist,
      watchlistLength: data.watchlist?.length || 0,
      watchlistType: typeof data.watchlist,
      pagination: data.pagination,
      paginationKeys: data.pagination ? Object.keys(data.pagination) : 'No pagination'
    });
    console.log(`[Admin Intelligence] Performance: Loaded ${data.watchlist?.length || 0} items in ${loadTime.toFixed(2)}ms`);
    
    if (data.success) {
      // Update pagination state
      secPaginationState.hasMore = data.pagination?.hasMore || false;
      secPaginationState.nextCursor = data.pagination?.nextCursor || null;
      secPaginationState.totalCount = data.pagination?.totalCount || null;
      
      // Cache the loaded chunk
      const cacheKey = cursor || 'first';
      secPaginationState.loadedChunks.set(cacheKey, data.watchlist);
      
      // Log optimization metrics
      const efficiency = data.pagination?.isFullMode ? 'Legacy (Full Collection)' : 'Optimized (Chunked)';
      console.log('[Admin Intelligence] Optimization metrics:', {
        mode: efficiency,
        itemCount: data.watchlist.length,
        hasMore: secPaginationState.hasMore,
        nextCursor: secPaginationState.nextCursor,
        totalCount: secPaginationState.totalCount,
        loadTime: `${loadTime.toFixed(2)}ms`,
        documentsRead: data.pagination?.isFullMode ? 'All' : limit
      });
      
      return data.watchlist;
    } else {
      console.error('[Admin Intelligence] SEC API error:', data.error);
      showToast('Failed to load SEC watchlist: ' + data.error, 'error');
      return null;
    }
  } catch (err) {
    const endTime = performance.now();
    const loadTime = endTime - startTime;
    console.error(`[Admin Intelligence] SEC chunk error after ${loadTime.toFixed(2)}ms:`, err);
    
    // Enhanced error handling for authentication issues
    if (err.message.includes('Authentication') || err.message.includes('auth')) {
      showToast('Authentication error. Please refresh the page.', 'error');
    } else {
      showToast('Failed to load SEC watchlist: ' + err.message, 'error');
    }
    
    return null;
  }
}

async function loadNextPage() {
  console.log('[Admin Intelligence] Loading next page...');
  
  if (!secPaginationState.hasMore || !secPaginationState.nextCursor) {
    console.log('[Admin Intelligence] No more pages to load');
    return;
  }
  
  secPaginationState.isLoading = true;
  
  try {
    const nextChunk = await loadSecWatchlistChunk(secPaginationState.nextCursor, 25);
    
    if (nextChunk) {
      secWatchlistData = nextChunk;
      renderSecTable(secWatchlistData);
      console.log('[Admin Intelligence] Next page loaded with', nextChunk.length, 'items');
    }
  } catch (err) {
    console.error('[Admin Intelligence] Error loading next page:', err);
    showToast('Failed to load next page', 'error');
  } finally {
    secPaginationState.isLoading = false;
  }
}

async function loadPreviousPage() {
  console.log('[Admin Intelligence] Loading previous page...');
  
  // For cursor-based pagination, we need to track navigation history
  // For simplicity, we'll reload from the beginning and navigate to the desired page
  secPaginationState.isLoading = true;
  
  try {
    // Reset and load from beginning
    await loadSecWatchlist();
    
    // Navigate to the desired page (simplified approach)
    // In a more complex implementation, we'd maintain a cursor stack
    for (let i = 1; i < secCurrentPage; i++) {
      if (secPaginationState.hasMore && secPaginationState.nextCursor) {
        const chunk = await loadSecWatchlistChunk(secPaginationState.nextCursor, 25);
        if (chunk) {
          secWatchlistData = chunk;
        }
      }
    }
    
    renderSecTable(secWatchlistData);
    console.log('[Admin Intelligence] Previous page loaded');
  } catch (err) {
    console.error('[Admin Intelligence] Error loading previous page:', err);
    showToast('Failed to load previous page', 'error');
  } finally {
    secPaginationState.isLoading = false;
  }
}

async function loadSecWatchlist() {
  console.log('[Admin Intelligence] loadSecWatchlist starting...');
  
  // Try to restore from sessionStorage cache first
  const cacheRestored = loadFromSessionStorage();
  if (cacheRestored && secWatchlistData.length > 0) {
    console.log('[Admin Intelligence] Using cached data, rendering immediately');
    renderSecTable(secWatchlistData.slice(0, secPerPage));
    updatePaginationControls();
    return;
  }
  
  // Call debug endpoint first to understand the data structure
  await debugSecWatchlist();
  
  // Reset pagination state (preserve search cache)
  const searchCacheBackup = secPaginationState.searchCache;
  secPaginationState = {
    hasMore: false,
    nextCursor: null,
    totalCount: null,
    isLoading: false,
    loadedChunks: new Map(),
    allDataLoaded: false,
    searchCache: searchCacheBackup,
    prefetchQueue: [],
    lastActivity: Date.now()
  };
  
  // Show loading state
  secPaginationState.isLoading = true;
  
  try {
    // Load first chunk with increased size
    const firstChunk = await loadSecWatchlistChunk(null, secPerPage);
    
    if (firstChunk) {
      secWatchlistData = firstChunk;
      
      // Update UI
      renderSecTable(secWatchlistData);
      
      // Update count with total if available, otherwise current count
      const count = secPaginationState.totalCount !== null ? secPaginationState.totalCount : secWatchlistData.length;
      document.getElementById('sec-count').textContent = count;
      
      console.log('[Admin Intelligence] SEC table rendered with', secWatchlistData.length, 'items');
      
      // Save to sessionStorage for faster subsequent loads
      saveToSessionStorage();
      
      // If there's more data, preload next chunk for smooth UX
      if (secPaginationState.hasMore && secPaginationState.nextCursor) {
        setTimeout(() => {
          loadSecWatchlistChunk(secPaginationState.nextCursor, secPerPage);
        }, 500);
      }
    }
  } catch (err) {
    console.error('[Admin Intelligence] SEC watchlist error:', err);
    renderSecError(err.message);
  } finally {
    secPaginationState.isLoading = false;
  }
}

function renderSecError(errorMsg = 'Failed to load data. Please try again.') {
  const tbody = document.getElementById('sec-tbody');
  const emptyState = document.getElementById('sec-empty');
  if (tbody) {
    tbody.innerHTML = `
      <tr>
        <td colspan="3" style="text-align: center; padding: var(--space-xl); color: #ef4444;">
          <div style="font-size: 24px; margin-bottom: var(--space-sm);">⚠️</div>
          <div style="font-weight: 500; margin-bottom: var(--space-sm);">Failed to load SEC watchlist</div>
          <div style="font-size: var(--font-sm); color: #9898B2; max-width: 400px; margin: 0 auto;">${escapeHtml(errorMsg)}</div>
        </td>
      </tr>
    `;
  }
  if (emptyState) emptyState.style.display = 'none';
  document.getElementById('sec-count').textContent = '!';
}

function renderSecTable(data) {
  console.log('[Admin Intelligence] renderSecTable called with', data.length, 'items');
  console.log('[Admin Intelligence] renderSecTable data type:', typeof data, 'isArray:', Array.isArray(data));
  
  const tbody = document.getElementById('sec-tbody');
  const emptyState = document.getElementById('sec-empty');

  console.log('[Admin Intelligence] tbody:', tbody, 'emptyState:', emptyState);

  if (!tbody || !emptyState) {
    console.error('[Admin Intelligence] Missing DOM elements for SEC table');
    return;
  }

  tbody.innerHTML = '';

  if (!Array.isArray(data)) {
    console.error('[Admin Intelligence] SEC data is not an array:', data);
    renderSecError('Invalid data format received');
    return;
  }

  if (data.length === 0) {
    console.log('[Admin Intelligence] Showing empty state for SEC');
    emptyState.style.display = 'block';
    tbody.style.display = 'none';
    return;
  }

  console.log('[Admin Intelligence] Hiding empty state and showing table');
  emptyState.style.display = 'none';
  tbody.style.display = 'table-row-group'; // Use proper display value for tbody
  
  // Also ensure the table itself is visible
  const table = document.getElementById('sec-table');
  if (table) {
    table.style.display = 'table';
    table.style.visibility = 'visible';
    table.style.opacity = '1';
  }
  
  // Ensure the table container is visible
  const tableContainer = tbody.closest('.table-responsive');
  if (tableContainer) {
    tableContainer.style.display = 'block';
    tableContainer.style.visibility = 'visible';
    tableContainer.style.opacity = '1';
    tableContainer.style.overflow = 'auto';
    tableContainer.style.height = 'auto';
  }
  
  // Debug CSS properties of table elements
  console.log('[Admin Intelligence] CSS Debug - Table element:', table);
  console.log('[Admin Intelligence] CSS Debug - Table container:', tableContainer);
  
  if (table) {
    console.log('[Admin Intelligence] CSS Debug - Table styles:', {
      display: window.getComputedStyle(table).display,
      visibility: window.getComputedStyle(table).visibility,
      opacity: window.getComputedStyle(table).opacity,
      height: window.getComputedStyle(table).height,
      width: window.getComputedStyle(table).width,
      overflow: window.getComputedStyle(table).overflow
    });
  }
  
  if (tableContainer) {
    console.log('[Admin Intelligence] CSS Debug - Container styles:', {
      display: window.getComputedStyle(tableContainer).display,
      visibility: window.getComputedStyle(tableContainer).visibility,
      opacity: window.getComputedStyle(tableContainer).opacity,
      height: window.getComputedStyle(tableContainer).height,
      overflow: window.getComputedStyle(tableContainer).overflow
    });
  }
  
  console.log('[Admin Intelligence] CSS Debug - Tbody styles:', {
    display: window.getComputedStyle(tbody).display,
    visibility: window.getComputedStyle(tbody).visibility,
    opacity: window.getComputedStyle(tbody).opacity
  });

  // --- Pagination Logic for Cursor-Based System ---
  console.log(`[Admin Intelligence] Rendering ${data.length} items for page ${secCurrentPage}`);

  // Update Pagination UI for cursor-based system
  const paginationContainer = document.getElementById('sec-pagination');
  const btnPrev = document.getElementById('sec-pagination-prev');
  const btnNext = document.getElementById('sec-pagination-next');
  const pageNumbersContainer = document.getElementById('sec-pagination-numbers');

  if (paginationContainer) {
    // Always show pagination if we have data or expect more data
    const shouldShowPagination = data.length > 0 || secPaginationState.hasMore;
    paginationContainer.style.display = shouldShowPagination ? 'flex' : 'none';

    // Update Previous button
    if (btnPrev) {
      btnPrev.style.display = secCurrentPage > 1 ? 'inline-flex' : 'none';
      btnPrev.disabled = secPaginationState.isLoading;
    }

    // Update Next button
    if (btnNext) {
      btnNext.style.display = secPaginationState.hasMore ? 'inline-flex' : 'none';
      btnNext.disabled = secPaginationState.isLoading;
    }

    // Generate page numbers (simplified for cursor-based system)
    if (pageNumbersContainer) {
      pageNumbersContainer.innerHTML = '';
      
      if (secPaginationState.totalCount !== null) {
        // If we know total count, show page numbers
        const totalPages = Math.ceil(secPaginationState.totalCount / secPerPage);
        const maxVisiblePages = 5;
        let startPage = Math.max(1, secCurrentPage - Math.floor(maxVisiblePages / 2));
        let endPage = Math.min(totalPages, startPage + maxVisiblePages - 1);
        
        if (endPage - startPage < maxVisiblePages) {
          startPage = Math.max(1, endPage - maxVisiblePages + 1);
        }
        
        for (let i = startPage; i <= endPage; i++) {
          const pageBtn = document.createElement('button');
          pageBtn.className = 'btn btn--sm';
          pageBtn.textContent = i;
          pageBtn.style.minWidth = '32px';
          pageBtn.style.padding = '4px 8px';
          pageBtn.style.borderRadius = '4px';
          pageBtn.style.fontSize = 'var(--font-xs)';
          pageBtn.style.fontWeight = '500';

          if (i === secCurrentPage) {
            pageBtn.style.background = 'var(--clr-accent, #6C63FF)';
            pageBtn.style.color = '#fff';
            pageBtn.style.border = '1px solid var(--clr-accent, #6C63FF)';
          } else {
            pageBtn.style.background = 'transparent';
            pageBtn.style.color = 'var(--clr-text-secondary)';
            pageBtn.style.border = '1px solid var(--clr-border)';
            pageBtn.style.cursor = 'pointer';
            pageBtn.addEventListener('click', async () => {
              if (secPaginationState.isLoading) return;
              secCurrentPage = i;
              await loadPreviousPage(); // Simplified: reload and navigate to page
            });
          }
          pageNumbersContainer.appendChild(pageBtn);
        }
      } else {
        // If we don't know total count, show current page and loading indicator
        const currentPageBtn = document.createElement('button');
        currentPageBtn.className = 'btn btn--sm';
        currentPageBtn.textContent = secCurrentPage;
        currentPageBtn.style.background = 'var(--clr-accent, #6C63FF)';
        currentPageBtn.style.color = '#fff';
        currentPageBtn.style.border = '1px solid var(--clr-accent, #6C63FF)';
        currentPageBtn.style.minWidth = '32px';
        currentPageBtn.style.padding = '4px 8px';
        currentPageBtn.style.borderRadius = '4px';
        currentPageBtn.style.fontSize = 'var(--font-xs)';
        currentPageBtn.style.fontWeight = '500';
        pageNumbersContainer.appendChild(currentPageBtn);
        
        if (secPaginationState.hasMore) {
          const dotsBtn = document.createElement('span');
          dotsBtn.textContent = '...';
          dotsBtn.style.padding = '4px 8px';
          dotsBtn.style.color = 'var(--clr-text-secondary)';
          pageNumbersContainer.appendChild(dotsBtn);
        }
      }
    }
  }

  console.log('[Admin Intelligence] Processing', data.length, 'items for display');
  console.log('[Admin Intelligence] Current tbody children count before adding:', tbody.children.length);
  
  // For cursor-based pagination, we display the data as received
  data.forEach((item, index) => {
    console.log(`[Admin Intelligence] Processing item ${index}:`, item);
    
    const row = document.createElement('tr');
    
    // Validate and extract data with fallbacks
    const companyName = item.company_name || 'Unknown Company';
    const category = item.category || 'Uncategorized';
    const dateScraped = formatDate(item.date_scraped);
    
    console.log(`[Admin Intelligence] Item ${index} - Company: ${companyName}, Category: ${category}, Date: ${dateScraped}`);
    
    row.innerHTML = `
      <td><strong>${escapeHtml(companyName)}</strong></td>
      <td><span class="badge badge--${getCategoryClass(category)}">${escapeHtml(category)}</span></td>
      <td>${escapeHtml(dateScraped)}</td>
    `;
    
    // Add click handler for modal with hover effects
    row.classList.add('row-clickable');
    row.style.cursor = 'pointer';
    row.addEventListener('click', () => showSecDetailModal(item));
    
    console.log(`[Admin Intelligence] Created row ${index} with HTML:`, row.innerHTML);
    tbody.appendChild(row);
    console.log(`[Admin Intelligence] Added row ${index}, tbody now has ${tbody.children.length} children`);
  });
  
  console.log('[Admin Intelligence] Final tbody children count:', tbody.children.length);
  console.log('[Admin Intelligence] Tbody innerHTML length:', tbody.innerHTML.length);
  
  // Force row visibility
  const rows = tbody.querySelectorAll('tr');
  rows.forEach((row, index) => {
    row.style.display = 'table-row';
    row.style.visibility = 'visible';
    row.style.opacity = '1';
    console.log(`[Admin Intelligence] Set row ${index} visibility`);
  });
  
  // Direct test: Force table visibility with inline styles (less aggressive)
  if (tableContainer) {
    tableContainer.style.display = 'block';
    tableContainer.style.visibility = 'visible';
    tableContainer.style.opacity = '1';
    console.log('[Admin Intelligence] Set table container visibility');
  }
  
  if (table) {
    table.style.display = 'table';
    table.style.visibility = 'visible';
    table.style.opacity = '1';
    console.log('[Admin Intelligence] Set table visibility');
  }
  
  // Final verification
  setTimeout(() => {
    const finalTable = document.getElementById('sec-table');
    const finalTbody = document.getElementById('sec-tbody');
    const finalEmpty = document.getElementById('sec-empty');
    
    console.log('[Admin Intelligence] Final verification:', {
      tableVisible: finalTable ? window.getComputedStyle(finalTable).display : 'not found',
      tbodyVisible: finalTbody ? window.getComputedStyle(finalTbody).display : 'not found',
      emptyHidden: finalEmpty ? window.getComputedStyle(finalEmpty).display : 'not found',
      tbodyRowCount: finalTbody ? finalTbody.children.length : 0
    });
  }, 100);
  
  console.log('[Admin Intelligence] SEC table rendering complete');
}

function formatDate(dateString) {
  if (!dateString) return 'N/A';
  
  try {
    const date = new Date(dateString);
    if (isNaN(date.getTime())) return dateString; // Return original if invalid date
    
    return date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    });
  } catch (error) {
    console.error('[Admin Intelligence] Date formatting error:', error);
    return dateString;
  }
}

function getCategoryClass(category) {
  const cat = (category || '').toLowerCase();
  if (cat.includes('ponzi') || cat.includes('investment')) return 'danger';
  if (cat.includes('lending')) return 'warning';
  return 'info';
}

// SEC Detail Modal Functions
function showSecDetailModal(item) {
  console.log('[Admin Intelligence] Showing detail modal for item:', item);
  
  const modal = document.getElementById('sec-detail-modal');
  const modalBody = modal.querySelector('.modal-body');
  
  const badgeConfig = getSecBadgeConfig(item.category);
  
  modalBody.innerHTML = `
    <h3>Target Entity</h3>
    <h2>${escapeHtml(item.company_name || 'Unknown Company')}</h2>
    
    <div class="modal-badge">
      <span class="badge badge--${badgeConfig.class}">${escapeHtml(badgeConfig.text)}</span>
    </div>
    
    <div class="modal-field">
      <label>Date Scraped</label>
      <p>${formatDate(item.date_scraped)}</p>
    </div>
    
    <div class="modal-actions">
      <a href="${escapeHtml(item.source_url || '#')}" target="_blank" class="btn btn--primary" ${item.source_url ? '' : 'style="opacity: 0.5; cursor: not-allowed;"'}>
        Verify Source via Official SEC Portal ↗
      </a>
    </div>
    
    <div class="compliance-notice">
      <h4>Compliance Audit Notice</h4>
      <p>This entity has been isolated by the automated background tracking array due to unauthorized financial operations violating consumer protection standards. To preserve absolute forensic chain-of-evidence integrity, raw administrative filings must be verified live on the primary government clearinghouse register.</p>
    </div>
  `;
  
  modal.style.display = 'flex';
  console.log('[Admin Intelligence] Modal displayed');
}

function getSecBadgeConfig(category) {
  console.log('[Admin Intelligence] Getting badge config for category:', category);
  
  if (category === "Investment/Ponzi Scam") {
    return { text: "🛑 UNLICENSED INVESTMENT SCHEME", class: "critical" };
  } else if (category === "Predatory/Illegal Lending") {
    return { text: "⚠️ UNREGULATED CREDIT VECTOR", class: "warning" };
  } else {
    return { text: category || 'Uncategorized', class: "info" };
  }
}

function closeSecDetailModal() {
  console.log('[Admin Intelligence] Closing detail modal');
  document.getElementById('sec-detail-modal').style.display = 'none';
}

// Add keyboard support for closing modal
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeSecDetailModal();
  }
});

// Add click outside to close modal
document.addEventListener('click', (e) => {
  const modal = document.getElementById('sec-detail-modal');
  if (e.target === modal) {
    closeSecDetailModal();
  }
});

// ── Search ─────────────────────────────────────────────────────────────────────

function initSearch() {
  const searchInput = document.getElementById('sec-search');
  if (!searchInput) return;

  searchInput.addEventListener('input', (e) => {
    const query = e.target.value.toLowerCase().trim();
    secCurrentPage = 1; // Reset page when searching
    
    // Clear existing debounce timer
    clearTimeout(searchDebounceTimer);
    
    // Debounce search requests
    searchDebounceTimer = setTimeout(async () => {
      secPaginationState.lastActivity = Date.now();
      
      if (!query) {
        // Reload first chunk when search is cleared
        await loadSecWatchlist();
        saveToSessionStorage();
        return;
      }

      // Check search cache first
      const cacheKey = query;
      if (secPaginationState.searchCache.has(cacheKey)) {
        const cachedResults = secPaginationState.searchCache.get(cacheKey);
        console.log('[Admin Intelligence] Using cached search results for:', query);
        renderSecTable(cachedResults);
        return;
      }

      // Search across all loaded chunks for better results
      let allLoadedData = [];
      for (const [cursor, chunkData] of secPaginationState.loadedChunks) {
        allLoadedData = allLoadedData.concat(chunkData);
      }
      
      const filtered = allLoadedData.filter(item =>
        (item.company_name || '').toLowerCase().includes(query) ||
        (item.sec_category || '').toLowerCase().includes(query) ||
        (item.category || '').toLowerCase().includes(query)
      );
      
      // Cache the search results
      secPaginationState.searchCache.set(cacheKey, filtered);
      
      // Limit cache size
      if (secPaginationState.searchCache.size > 20) {
        const firstKey = secPaginationState.searchCache.keys().next().value;
        secPaginationState.searchCache.delete(firstKey);
      }
      
      renderSecTable(filtered);
      saveToSessionStorage();
      
      // Show message if there might be more results in other chunks
      if (filtered.length === 0 && secPaginationState.hasMore) {
        showToast('No results in loaded data. Try loading more data or use a different search term.', 'info');
      } else if (filtered.length > 0) {
        console.log(`[Admin Intelligence] Found ${filtered.length} results for "${query}"`);
      }
    }, 300); // 300ms debounce delay
  });
}

// ── Training Corpus ──────────────────────────────────────────────────────────

async function loadTrainingCorpus() {
  try {
    const response = await makeAuthenticatedRequest('/api/admin/training-corpus?limit=1000');

    if (!response.ok) {
      // Handle specific authentication errors
      if (response.status === 401) {
        console.error('[Admin Intelligence] Authentication failed for training corpus');
        showToast('Authentication failed. Please refresh the page.', 'error');
        throw new Error('Authentication failed');
      }
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();
    if (data.success) {
      corpusData = data.corpus || [];
      renderCorpusTable(corpusData);
      document.getElementById('corpus-count').textContent = data.count || corpusData.length;
    } else {
      showToast('Failed to load training corpus: ' + data.error, 'error');
    }
  } catch (err) {
    console.error('[Admin Intelligence] Training corpus error:', err);
    showToast('Failed to load training corpus', 'error');
  }
}

function renderCorpusTable(data) {
  const tbody = document.getElementById('corpus-tbody');
  const emptyState = document.getElementById('corpus-empty');

  tbody.innerHTML = '';

  if (data.length === 0) {
    emptyState.style.display = 'block';
    return;
  }

  emptyState.style.display = 'none';

  // --- Pagination Logic ---
  const totalPages = Math.ceil(data.length / corpusPerPage);
  if (corpusCurrentPage > totalPages) corpusCurrentPage = totalPages;
  if (corpusCurrentPage < 1) corpusCurrentPage = 1;

  const startIndex = (corpusCurrentPage - 1) * corpusPerPage;
  const paginatedData = data.slice(startIndex, startIndex + corpusPerPage);

  // Update Pagination UI
  const paginationContainer = document.getElementById('corpus-pagination');
  const btnPrev = document.getElementById('corpus-pagination-prev');
  const btnNext = document.getElementById('corpus-pagination-next');
  const pageNumbersContainer = document.getElementById('corpus-pagination-numbers');

  if (paginationContainer) {
    paginationContainer.style.display = totalPages > 1 ? 'flex' : 'none';

    // Show/hide Previous button (hidden on page 1)
    if (btnPrev) btnPrev.style.display = corpusCurrentPage > 1 ? 'inline-flex' : 'none';

    // Show/hide Next button (hidden on last page)
    if (btnNext) btnNext.style.display = corpusCurrentPage < totalPages ? 'inline-flex' : 'none';

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

        if (i === corpusCurrentPage) {
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
            corpusCurrentPage = i;
            renderCorpusTable(data);
          });
        }
        pageNumbersContainer.appendChild(pageBtn);
      }
    }
  }

  paginatedData.forEach(item => {
    const row = document.createElement('tr');
    const classificationClass = item.classification === 'Confirmed Threat' ? 'danger' :
                                item.classification === 'Verified Safe' ? 'success' : 'warning';

    row.innerHTML = `
      <td style="max-width: 400px;" title="${escapeHtml(item.full_text || '')}">
        <div style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
          ${escapeHtml(item.anonymized_text || '—')}
        </div>
      </td>
      <td><span class="badge badge--${classificationClass}">${escapeHtml(item.classification)}</span></td>
      <td>${escapeHtml(formatDate(item.created_at))}</td>
    `;
    tbody.appendChild(row);
  });
}

// ── Export JSONL ─────────────────────────────────────────────────────────────

function initExportButton() {
  const btn = document.getElementById('btn-export-jsonl');
  if (!btn) return;

  btn.addEventListener('click', exportCorpusAsJsonl);
}

async function exportCorpusAsJsonl() {
  if (corpusData.length === 0) {
    showToast('No training data to export', 'error');
    return;
  }

  try {
    // Fetch full corpus data (not truncated)
    const response = await makeAuthenticatedRequest('/api/admin/training-corpus?limit=10000');

    if (!response.ok) {
      // Handle specific authentication errors
      if (response.status === 401) {
        console.error('[Admin Intelligence] Authentication failed for corpus export');
        showToast('Authentication failed. Please refresh the page.', 'error');
        throw new Error('Authentication failed');
      }
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();
    if (!data.success) {
      throw new Error(data.error || 'Failed to fetch corpus');
    }

    const fullData = data.corpus || [];

    // Convert to JSONL format for LLM training
    const jsonlLines = fullData.map(item => {
      // Map classification to simple labels for LLM training
      const label = item.classification === 'Confirmed Threat' ? 'threat' :
                    item.classification === 'Verified Safe' ? 'safe' : 'unknown';

      return JSON.stringify({
        text: item.full_text || item.anonymized_text || '',
        label: label,
        platform: item.platform || 'Unknown',
        report_id: item.report_id || '',
        created_at: item.created_at || ''
      });
    });

    const jsonlContent = jsonlLines.join('\n');

    // Create download
    const blob = new Blob([jsonlContent], { type: 'application/jsonl' });
    const url = URL.createObjectURL(blob);
    const timestamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');

    const a = document.createElement('a');
    a.href = url;
    a.download = `suriin_training_corpus_${timestamp}.jsonl`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    showToast(`Exported ${fullData.length} records as JSONL`, 'success');
  } catch (err) {
    console.error('[Admin Intelligence] Export error:', err);
    showToast('Failed to export corpus: ' + err.message, 'error');
  }
}

// ── Migrate Historical Data ──────────────────────────────────────────────────

function initMigrateButton() {
  const btn = document.getElementById('btn-migrate-data');
  if (!btn) return;

  btn.addEventListener('click', migrateHistoricalData);
}

async function migrateHistoricalData() {
  const btn = document.getElementById('btn-migrate-data');
  const statusDiv = document.getElementById('migration-status');
  const messageSpan = document.getElementById('migration-message');

  try {
    // Show loading state
    btn.disabled = true;
    btn.innerHTML = '<span>⏳</span><span>Migrating...</span>';
    if (statusDiv) {
      statusDiv.style.display = 'block';
      messageSpan.textContent = 'Migrating historical data...';
    }

    const response = await makeAuthenticatedRequest('/api/admin/migrate-historical-data', {
      method: 'POST'
    });

    if (!response.ok) {
      // Handle specific authentication errors
      if (response.status === 401) {
        console.error('[Admin Intelligence] Authentication failed for data migration');
        showToast('Authentication failed. Please refresh the page.', 'error');
        throw new Error('Authentication failed');
      }
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();
    if (!data.success) {
      throw new Error(data.error || 'Migration failed');
    }

    // Show success message
    if (statusDiv) {
      statusDiv.style.background = 'rgba(34, 197, 94, 0.1)';
      statusDiv.style.borderColor = 'rgba(34, 197, 94, 0.3)';
      messageSpan.textContent = `✅ Migration complete! Migrated: ${data.migrated}, Skipped: ${data.skipped}, Errors: ${data.errors}`;
    }

    showToast(`Migration complete! ${data.migrated} reports migrated.`, 'success');

    // Refresh corpus data
    await loadTrainingCorpus();

  } catch (err) {
    console.error('[Admin Intelligence] Migration error:', err);
    showToast('Migration failed: ' + err.message, 'error');

    if (statusDiv) {
      statusDiv.style.background = 'rgba(239, 68, 68, 0.1)';
      statusDiv.style.borderColor = 'rgba(239, 68, 68, 0.3)';
      messageSpan.textContent = '❌ Migration failed: ' + err.message;
    }
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<span>🔄</span><span>Migrate Historical Data</span>';
  }
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function escapeHtml(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast toast--${type}`;
  toast.style.cssText = `
    background: ${type === 'error' ? '#ef4444' : type === 'success' ? '#22c55e' : '#6C63FF'};
    color: white;
    padding: 12px 20px;
    border-radius: 8px;
    margin-bottom: 10px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    animation: slideIn 0.3s ease;
    font-size: 14px;
    max-width: 400px;
  `;
  toast.textContent = message;

  container.appendChild(toast);

  setTimeout(() => {
    toast.style.animation = 'slideOut 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

// ── Cleanup ───────────────────────────────────────────────────────────────────

window.addEventListener('beforeunload', () => {
  // Cleanup if needed
});

// ── SEC Whitelist (Legitimate Registered Entities) ───────────────────────────

let secWhitelistData = [];
let whitelistCurrentPage = 1;
const whitelistPerPage = 25;
let whitelistDataLoaded = false;
let whitelistPaginationState = {
  hasMore: false,
  nextCursor: null,
  totalCount: null,
  isLoading: false
};

async function loadSecWhitelist(cursor = null) {
  console.log('[Admin Intelligence] Loading SEC Whitelist chunk...', { cursor });
  whitelistPaginationState.isLoading = true;

  try {
    const params = new URLSearchParams({ limit: '25' });
    if (cursor) params.append('cursor', cursor);

    const response = await makeAuthenticatedRequest(`/api/admin/sec-whitelist?${params}`);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();
    if (data.success) {
      const items = data.whitelist || [];
      secWhitelistData = items;
      whitelistPaginationState.hasMore = data.pagination?.hasMore || false;
      whitelistPaginationState.nextCursor = data.pagination?.nextCursor || null;
      whitelistPaginationState.totalCount = data.pagination?.totalCount || items.length;

      const countBadge = document.getElementById('whitelist-count');
      if (countBadge) {
        countBadge.textContent = whitelistPaginationState.totalCount;
      }

      renderWhitelistTable(secWhitelistData);
      whitelistDataLoaded = true;
    }
  } catch (err) {
    console.error('[Admin Intelligence] Error loading SEC whitelist:', err);
    showToast('Failed to load SEC Whitelist: ' + err.message, 'error');
  } finally {
    whitelistPaginationState.isLoading = false;
  }
}

function renderWhitelistTable(data) {
  const tbody = document.getElementById('whitelist-tbody');
  const emptyState = document.getElementById('whitelist-empty');

  if (!tbody) return;

  if (!data || data.length === 0) {
    tbody.innerHTML = '';
    if (emptyState) emptyState.style.display = 'block';
    updateWhitelistPagination();
    return;
  }

  if (emptyState) emptyState.style.display = 'none';

  tbody.innerHTML = data.map(item => `
    <tr>
      <td style="font-weight: 600; color: #fff;">
        <div style="display: flex; align-items: center; gap: 8px;">
          <span style="font-size: 1.1rem;">🏢</span>
          <span>${escapeHtml(item.company_name)}</span>
        </div>
      </td>
      <td>
        <span style="font-family: monospace; background: rgba(108,99,255,0.15); color: #6C63FF; padding: 2px 8px; border-radius: 4px; font-size: 0.85rem;">
          ${escapeHtml(item.sec_registration_no || 'CS-REGISTERED')}
        </span>
      </td>
      <td style="color: #cbd5e1;">${escapeHtml(item.category || 'SEC Registered Entity')}</td>
      <td>
        <span style="background: rgba(34,197,94,0.15); color: #22c55e; border: 1px solid rgba(34,197,94,0.3); padding: 4px 8px; border-radius: 6px; font-size: 0.8rem; font-weight: 600;">
          ✓ ${escapeHtml(item.status || 'REGISTERED')}
        </span>
      </td>
    </tr>
  `).join('');

  updateWhitelistPagination();
}

function updateWhitelistPagination() {
  const footer = document.getElementById('whitelist-pagination');
  const btnPrev = document.getElementById('whitelist-pagination-prev');
  const btnNext = document.getElementById('whitelist-pagination-next');
  const numbers = document.getElementById('whitelist-pagination-numbers');

  if (!footer) return;
  footer.style.display = 'flex';

  if (btnPrev) {
    btnPrev.style.display = whitelistCurrentPage > 1 ? 'inline-flex' : 'none';
  }
  if (btnNext) {
    btnNext.style.display = whitelistPaginationState.hasMore ? 'inline-flex' : 'none';
  }

  if (numbers) {
    numbers.innerHTML = `<span style="color: #9898B2; font-size: 0.875rem;">Page ${whitelistCurrentPage} (Loaded ${secWhitelistData.length} of ${whitelistPaginationState.totalCount || secWhitelistData.length} records)</span>`;
  }
}

// Whitelist search filtering & event listeners
document.addEventListener('DOMContentLoaded', () => {
  const whitelistSearch = document.getElementById('whitelist-search');
  if (whitelistSearch) {
    whitelistSearch.addEventListener('input', (e) => {
      const term = e.target.value.trim().toLowerCase();
      if (!term) {
        renderWhitelistTable(secWhitelistData);
        return;
      }
      const filtered = secWhitelistData.filter(item => 
        (item.company_name && item.company_name.toLowerCase().includes(term)) ||
        (item.sec_registration_no && item.sec_registration_no.toLowerCase().includes(term)) ||
        (item.category && item.category.toLowerCase().includes(term))
      );
      renderWhitelistTable(filtered);
    });
  }

  const btnSyncWhitelist = document.getElementById('btn-sync-whitelist');
  if (btnSyncWhitelist) {
    btnSyncWhitelist.addEventListener('click', async () => {
      try {
        btnSyncWhitelist.disabled = true;
        btnSyncWhitelist.textContent = 'Syncing...';
        const response = await makeAuthenticatedRequest('/api/admin/sync-sec-whitelist', { method: 'POST' });
        const data = await response.json();
        if (data.success) {
          showToast(data.message, 'success');
          await loadSecWhitelist();
        } else {
          showToast('Sync failed: ' + data.error, 'error');
        }
      } catch (e) {
        showToast('Sync error: ' + e.message, 'error');
      } finally {
        btnSyncWhitelist.disabled = false;
        btnSyncWhitelist.innerHTML = '<span>🔄</span> <span>Sync Whitelist</span>';
      }
    });
  }

  const btnPrev = document.getElementById('whitelist-pagination-prev');
  const btnNext = document.getElementById('whitelist-pagination-next');

  if (btnNext) {
    btnNext.addEventListener('click', async () => {
      if (whitelistPaginationState.hasMore && whitelistPaginationState.nextCursor) {
        whitelistCurrentPage++;
        await loadSecWhitelist(whitelistPaginationState.nextCursor);
      }
    });
  }

  if (btnPrev) {
    btnPrev.addEventListener('click', async () => {
      if (whitelistCurrentPage > 1) {
        whitelistCurrentPage--;
        await loadSecWhitelist(null);
      }
    });
  }
});

