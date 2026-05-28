/**
 * admin-dashboard.js — Admin platform operations and system health metrics.
 */

'use strict';

window.addEventListener('suriin:auth-ready', (e) => {
	const { role } = e.detail;
	if (role !== 'admin') {
		window.location.href = '/admin-dashboard';
		return;
	}

	loadOperationsMetrics();
	loadBackendHealth();
});

async function loadOperationsMetrics() {
	const db = window.__suriinFirestore;
	if (!db) {
		console.error('[SuriinAI Admin] Firestore not available.');
		return;
	}

	try {
		const reportsSnapshot = await db.collection('Reports').get();
		const reports = reportsSnapshot.docs.map((doc) => doc.data() || {});
		const totalReports = reports.length;
		const pendingReports = reports.filter((r) => r.status === 'Pending').length;
		const investigatingReports = reports.filter((r) => r.status === 'Under Investigation' || r.status === 'Investigating').length;
		const reviewedReports = reports.filter((r) => r.status === 'Reviewed').length;

		// Report Lifecycle Funnel (top cards)
		setText('stat-total-reports', String(totalReports));
		setText('stat-pending-reports', String(pendingReports));
		setText('stat-investigating-reports', String(investigatingReports));
		setText('stat-reviewed-reports', String(reviewedReports));

		const updatedEl = document.getElementById('status-last-updated');
		if (updatedEl) updatedEl.textContent = new Date().toLocaleString();

		// Remove skeleton classes after data loads
		document.querySelectorAll('.stat-card__value.is-skeleton').forEach(el => {
			el.classList.remove('is-skeleton');
		});
		document.querySelectorAll('.stat-card__label.is-skeleton').forEach(el => {
			el.classList.remove('is-skeleton');
		});

	} catch (err) {
		console.error('[SuriinAI Admin] Failed to load operations metrics:', err);
		alert('Failed to load metrics. Check Firestore permissions.');
	}
}

function setText(id, value) {
	const el = document.getElementById(id);
	if (el) el.textContent = value;
}

async function loadBackendHealth() {
	const backendStatusEl = document.getElementById('health-backend-status');
	const serverTimeEl = document.getElementById('health-server-time');
	const uptimeEl = document.getElementById('health-uptime');
	const firebaseAdminEl = document.getElementById('health-firebase-admin');
	
	// Services & Detection Engines
	const firestoreEl = document.getElementById('health-firestore');
	const firebaseAuthEl = document.getElementById('health-firebase-auth');
	const nlpModelEl = document.getElementById('health-nlp-model');
	const roiEngineEl = document.getElementById('health-roi-engine');
	const blacklistApiEl = document.getElementById('health-blacklist-api');
	const extensionSyncApiEl = document.getElementById('health-extension-sync-api');

	try {
		const res = await fetch('/api/health', { method: 'GET' });
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const data = await res.json();

		// Core Backend
		if (backendStatusEl) backendStatusEl.innerHTML = '<span class="badge badge--resolved">OK</span>';
		if (serverTimeEl) renderServerTime(serverTimeEl, data.server_time_utc);
		if (uptimeEl) uptimeEl.textContent = formatUptime(data.uptime_seconds);
		// Services & Detection Engines
		if (firebaseAdminEl) {
			firebaseAdminEl.innerHTML = data.firebase_admin_ok
				? '<span class="badge badge--resolved">OK</span>'
				: '<span class="badge badge--critical">Fail</span>';
		}
		
		// Mock services status (green/ready badges)
		if (firestoreEl) firestoreEl.innerHTML = '<span class="badge badge--resolved">Connected</span>';
		if (firebaseAuthEl) firebaseAuthEl.innerHTML = '<span class="badge badge--resolved">Operational</span>';
		if (nlpModelEl) nlpModelEl.innerHTML = '<span class="badge badge--resolved">Ready</span>';
		if (roiEngineEl) roiEngineEl.innerHTML = '<span class="badge badge--resolved">Ready</span>';
		if (blacklistApiEl) blacklistApiEl.innerHTML = '<span class="badge badge--resolved">Ready</span>';

		if (extensionSyncApiEl) {
			try {
				const syncRes = await fetch('/api/extension/status', { method: 'GET' });
				if (!syncRes.ok) throw new Error(`HTTP ${syncRes.status}`);
				const syncData = await syncRes.json();
				const syncOk = String(syncData?.status || '').trim().toLowerCase() === 'online';
				extensionSyncApiEl.innerHTML = syncOk
					? '<span class="badge badge--resolved">Connected</span>'
					: '<span class="badge badge--critical">Unavailable</span>';
			} catch (err) {
				extensionSyncApiEl.innerHTML = '<span class="badge badge--critical">Unavailable</span>';
			}
		}
		
	} catch (err) {
		console.warn('[SuriinAI Admin] Failed to load backend health:', err);
		if (backendStatusEl) backendStatusEl.innerHTML = '<span class="badge badge--critical">Unavailable</span>';
		if (firebaseAdminEl) firebaseAdminEl.innerHTML = '<span class="badge badge--critical">Unavailable</span>';
		
		// Set services to unavailable on error
		if (firestoreEl) firestoreEl.innerHTML = '<span class="badge badge--critical">Unavailable</span>';
		if (firebaseAuthEl) firebaseAuthEl.innerHTML = '<span class="badge badge--critical">Unavailable</span>';
		if (nlpModelEl) nlpModelEl.innerHTML = '<span class="badge badge--critical">Unavailable</span>';
		if (roiEngineEl) roiEngineEl.innerHTML = '<span class="badge badge--critical">Unavailable</span>';
		if (blacklistApiEl) blacklistApiEl.innerHTML = '<span class="badge badge--critical">Unavailable</span>';
		if (extensionSyncApiEl) extensionSyncApiEl.innerHTML = '<span class="badge badge--critical">Unavailable</span>';
	}
}

function renderServerTime(targetEl, isoUtc) {
	if (!targetEl) return;

	const local = formatDateTime(isoUtc);
	const utc = formatDateTime(isoUtc, 'UTC');
	if (!local || !utc) {
		targetEl.textContent = '—';
		return;
	}

	targetEl.textContent = '';
	const line1 = document.createElement('div');
	line1.textContent = local;
	const line2 = document.createElement('div');
	line2.className = 'system-status__subtext';
	line2.textContent = `${utc} UTC`;
	targetEl.appendChild(line1);
	targetEl.appendChild(line2);
}

function formatDateTime(isoString, timeZone) {
	if (!isoString) return '';
	const d = new Date(isoString);
	if (Number.isNaN(d.getTime())) return '';
	const opts = {
		month: 'short',
		day: '2-digit',
		year: 'numeric',
		hour: '2-digit',
		minute: '2-digit',
		hour12: true,
	};
	if (timeZone) opts.timeZone = timeZone;
	return d.toLocaleString('en-US', opts);
}

function formatUptime(uptimeSeconds) {
	const s = Number(uptimeSeconds);
	if (!Number.isFinite(s) || s < 0) return '—';
	const seconds = Math.floor(s % 60);
	const minutes = Math.floor((s / 60) % 60);
	const hours = Math.floor((s / 3600) % 24);
	const days = Math.floor(s / 86400);
	if (days > 0) return `${days}d ${hours}h ${minutes}m ${seconds}s`;
	if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
	if (minutes > 0) return `${minutes}m ${seconds}s`;
	return `${seconds}s`;
}

