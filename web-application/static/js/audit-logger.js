/**
 * audit-logger.js — Shared utility for writing audit log entries to Firestore.
 * Used by both Admin and Expert workflows to track system-altering actions.
 */

'use strict';

/**
 * Log an audit event to the 'audit_logs' collection.
 *
 * @param {Object} params
 * @param {string} params.action - Action type (e.g., 'SUSPEND_USER', 'ROLE_CHANGE', 'CLAIM_REPORT')
 * @param {string} params.targetId - ID of the affected user or report
 * @param {string} params.targetType - 'user' | 'report'
 * @param {string} params.details - Human-readable description of the action
 * @param {Object} [params.metadata] - Optional additional context
 * @returns {Promise<string|null>} - Document ID if successful, null otherwise
 */
async function logAuditEvent({ action, targetId, targetType, details, metadata = {} }) {
	const db = window.__suriinFirestore;
	const auth = window.__suriinAuth;

	if (!db) {
		console.error('[AuditLogger] Firestore not available');
		return null;
	}

	if (!auth?.user) {
		console.error('[AuditLogger] User not authenticated');
		return null;
	}

	const user = auth.user;

	try {
		const docRef = await db.collection('audit_logs').add({
			timestamp: firebase.firestore.FieldValue.serverTimestamp(),
			actorId: user.uid,
			actorEmail: user.email || 'unknown',
			actorRole: auth.role || 'unknown',
			action: action,
			targetId: targetId,
			targetType: targetType,
			details: details,
			metadata: metadata
		});

		console.log(`[AuditLogger] Logged ${action} for ${targetType} ${targetId}`);
		return docRef.id;
	} catch (err) {
		console.error('[AuditLogger] Failed to write audit log:', err);
		return null;
	}
}

// Expose globally for use across admin and expert pages
window.logAuditEvent = logAuditEvent;
