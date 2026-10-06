/**
 * Which aiq-agent address the chat WebSocket proxy in `server.js` dials.
 *
 * Two modes, picked by `GRID_CHAT_AFFINITY` (ADR-0079), on by default:
 *
 * - **Affinity on** (ADR-0028): a stable hash of the conversation id picks one
 *   replica's own DNS name, `aiq-agent-<i>.aiq-agent-headless`, so a
 *   conversation always reaches the process that holds its socket state. The
 *   hash is taken modulo the replica count, so the count is part of the
 *   routing: it is static, and the tier cannot autoscale. With one replica, no
 *   pod template or no conversation id it falls back to the load-balanced
 *   Service, which is also what single-replica deployments have always used.
 * - **Affinity off**: every socket goes to the load-balanced Service. Which
 *   replica runs a turn is decided per turn on the conversation bus
 *   (`aiq_api/conversation_bus.py`), and a socket on any replica relays the
 *   turn's frames from Dragonfly, so no routing key is needed and replicas can
 *   come and go (KEDA scales the StatefulSet).
 *
 * CommonJS and import-free because `server.js` requires it at startup; the
 * production image copies it in by path (`deploy/Dockerfile`).
 */

/** `GRID_CHAT_AFFINITY`: anything but an explicit off value is on, so an unset variable keeps today's routing. */
function affinityEnabled(raw) {
  const value = String(raw === undefined ? '1' : raw).trim().toLowerCase()
  return !['0', 'false', 'no', 'off'].includes(value)
}

// FNV-1a: stable, dependency-free, well-distributed for short ids.
function hashToIndex(str, mod) {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0) % mod
}

/**
 * @param {{ replicas: number, podTemplate: string, affinity: boolean, serviceUrl: string }} config
 * @returns {(conversationId?: string | null) => string} the WebSocket origin to dial for a conversation
 */
function createBackendTargetPicker({ replicas, podTemplate, affinity, serviceUrl }) {
  return (conversationId) => {
    if (!affinity || replicas <= 1 || !podTemplate || !conversationId) return serviceUrl
    return podTemplate.replace('{i}', String(hashToIndex(String(conversationId), replicas)))
  }
}

module.exports = { affinityEnabled, createBackendTargetPicker, hashToIndex }
