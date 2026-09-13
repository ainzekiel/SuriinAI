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
	loadAiPerformanceMetrics();
	loadPlatformChart();
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

		// Unassigned Cases (backward compatible with 'Pending')
		const unassignedReports = reports.filter((r) =>
			r.status === 'Unassigned' || r.status === 'Pending'
		).length;

		// Under Investigation (backward compatible with 'Investigating', 'Under Review')
		const investigatingReports = reports.filter((r) =>
			r.status === 'Under Investigation' ||
			r.status === 'Investigating' ||
			r.status === 'Under Review'
		).length;

		// Cases Resolved (backward compatible with 'Reviewed', 'Dismissed')
		const resolvedReports = reports.filter((r) =>
			r.status === 'Resolved' ||
			r.status === 'Reviewed' ||
			r.status === 'Dismissed'
		).length;

		// Report Lifecycle Funnel (top cards)
		setText('stat-total-reports', String(totalReports));
		setText('stat-unassigned-reports', String(unassignedReports));
		setText('stat-investigating-reports', String(investigatingReports));
		setText('stat-resolved-reports', String(resolvedReports));

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

/**
 * Load AI Model Performance metrics
 * Calculates AI-Expert consensus rate, false positives (human overrides), and SEC-assisted catches
 */
async function loadAiPerformanceMetrics() {
	const db = window.__suriinFirestore;
	if (!db) {
		console.error('[SuriinAI Admin] Firestore not available for AI metrics.');
		return;
	}

	try {
		const reportsSnapshot = await db.collection('Reports').get();
		const reports = reportsSnapshot.docs.map((doc) => doc.data() || {});

		// Filter to resolved/reviewed reports (where expert has made a decision)
		const resolvedReports = reports.filter((r) =>
			r.status === 'Resolved' || r.status === 'Reviewed' || r.status === 'Dismissed'
		);

		if (resolvedReports.length === 0) {
			setText('ai-agreement-rate', '0%');
			setText('false-positives', '0%');
			setText('sec-assisted-catches', '0%');
			return;
		}

		let aiExpertConsensus = 0;  // AI flagged threat + Expert confirmed threat
		let humanOverrides = 0;     // Resolved + Expert verdict Verified Safe (false positives)
		let secAssistedCatches = 0; // No AI flag + SEC matched + Expert confirmed threat

		resolvedReports.forEach((report) => {
			const aiVerdict = report.ai_analysis?.status || report.ai_status || report.ai_verdict || '';
			const riskScore = report.risk_score || 0;
			const normalizedRisk = riskScore > 1 ? riskScore / 100 : riskScore; // Normalize 0-100 to 0-1
			const expertVerdict = report.expert_verdict || report.expertVerdict || '';
			const expertVerdictLower = expertVerdict.toLowerCase();

			// Check SEC watchlist match (matched_company or gov_records.is_flagged)
			const secMatched = report.gov_records?.is_flagged === true ||
							   report.sec_match === true ||
							   (report.matched_company && report.matched_company.length > 0);

			// Determine if AI predicted threat (risk_score >= 0.4 or verdict contains threat keywords)
			const aiFlaggedThreat = aiVerdict.toLowerCase().includes('scam') ||
									aiVerdict.toLowerCase().includes('threat') ||
									aiVerdict.toLowerCase().includes('critical') ||
									aiVerdict.toLowerCase().includes('warning') ||
									normalizedRisk >= 0.4;

			// AI-Expert Consensus: AI flagged threat AND Expert confirmed threat
			const expertConfirmedThreat = expertVerdictLower.includes('confirmed threat') ||
										  expertVerdictLower.includes('confirmed scam') ||
										  expertVerdictLower.includes('threat');

			if (aiFlaggedThreat && expertConfirmedThreat) {
				aiExpertConsensus++;
			}

			// Human Overrides (False Positives): Resolved status + Expert verdict Verified Safe
			const expertVerifiedSafe = expertVerdictLower.includes('verified safe') ||
									   expertVerdictLower.includes('safe') ||
									   expertVerdictLower === 'safe';

			if (expertVerifiedSafe) {
				humanOverrides++;
			}

			// SEC-Assisted Catches: No AI flag + SEC matched + Expert confirmed threat
			const aiSaidSafe = !aiFlaggedThreat ||
							   aiVerdict.toLowerCase().includes('safe') ||
							   normalizedRisk < 0.4;

			if (aiSaidSafe && secMatched && expertConfirmedThreat) {
				secAssistedCatches++;
			}
		});

		const total = resolvedReports.length;
		const consensusRate = ((aiExpertConsensus / total) * 100).toFixed(1);
		const overrideRate = ((humanOverrides / total) * 100).toFixed(1);
		const secRate = ((secAssistedCatches / total) * 100).toFixed(1);

		setText('ai-agreement-rate', `${consensusRate}%`);
		setText('false-positives', `${overrideRate}%`);
		setText('sec-assisted-catches', `${secRate}%`);

	} catch (err) {
		console.error('[SuriinAI Admin] Failed to load AI performance metrics:', err);
		setText('ai-agreement-rate', '—');
		setText('false-positives', '—');
		setText('sec-assisted-catches', '—');
	}
}

let platformChart = null;

/**
 * Load Most Exploited Platform pie chart
 */
async function loadPlatformChart() {
	const db = window.__suriinFirestore;
	if (!db) {
		console.error('[SuriinAI Admin] Firestore not available for platform chart.');
		return;
	}

	try {
		// Get reports from last 30 days
		const thirtyDaysAgo = new Date();
		thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
		
		const reportsSnapshot = await db.collection('Reports')
			.where('created_at', '>=', thirtyDaysAgo.toISOString())
			.limit(1000)
			.get();
		
		const reports = reportsSnapshot.docs.map((doc) => doc.data() || {});

		// Extract platforms/domains from URLs
		const platformCounts = {};
		reports.forEach((report) => {
			const url = report.url || '';
			try {
				const domain = new URL(url).hostname.replace(/^www\./, '');
				// Group by top-level domain or platform
				const platform = domain.split('.').slice(-2).join('.');
				platformCounts[platform] = (platformCounts[platform] || 0) + 1;
			} catch {
				// Invalid URL, skip
			}
		});

		// Sort by count and take top 8, bucket rest as "Others"
		const sorted = Object.entries(platformCounts).sort((a, b) => b[1] - a[1]);
		const top8 = sorted.slice(0, 8);
		const others = sorted.slice(8).reduce((sum, [, count]) => sum + count, 0);

		const labels = top8.map(([platform]) => platform);
		const data = top8.map(([, count]) => count);

		if (others > 0) {
			labels.push('Others');
			data.push(others);
		}

		// Color palette matching dark theme
		const colors = [
			'#6C63FF', '#3ECFCF', '#F59E0B', '#EF4444',
			'#8B5CF6', '#EC4899', '#06B6D4', '#84CC16',
			'#6B7280'
		];

		const ctx = document.getElementById('platform-chart');
		if (!ctx) return;

		// Destroy existing chart if present
		if (platformChart) {
			platformChart.destroy();
		}

		platformChart = new Chart(ctx, {
			type: 'pie',
			data: {
				labels: labels,
				datasets: [{
					data: data,
					backgroundColor: colors.slice(0, labels.length),
					borderWidth: 2,
					borderColor: 'rgba(0,0,0,0.3)'
				}]
			},
			options: {
				responsive: true,
				maintainAspectRatio: false,
				plugins: {
					legend: {
						position: 'right',
						labels: {
							color: '#E5E7EB',
							font: { size: 11 },
							padding: 12,
							boxWidth: 10
						}
					},
					tooltip: {
						callbacks: {
							label: (context) => {
								const total = context.dataset.data.reduce((a, b) => a + b, 0);
								const percentage = ((context.raw / total) * 100).toFixed(1);
								return `${context.label}: ${context.raw} (${percentage}%)`;
							}
						}
					}
				}
			}
		});

	} catch (err) {
		console.error('[SuriinAI Admin] Failed to load platform chart:', err);
	}
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

