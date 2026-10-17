/*
 * Piloti service worker: system notifications for the inbox, and nothing else
 * (Web Push, ADR-0112).
 *
 * What it does:
 *   - push                 shows the notification the server sent
 *   - notificationclick    marks the item read, then focuses an open Piloti tab
 *                          and takes it to the item, or opens one
 *   - pushsubscriptionchange   subscribes again and tells the server
 *   - message              closes notifications the page says are no longer news
 *
 * What it must never do: cache anything. There is NO `fetch` event handler here
 * and no Cache Storage use, on purpose. Piloti serves several offices from one
 * origin, and a worker that answered requests from a cache could answer one
 * person with what another person's session fetched, or keep a revoked
 * document alive on a device. The browser's own HTTP cache rules stay in charge
 * of every request. The worker calls `fetch()` twice, to mark a tapped item
 * read and to re-register a rotated subscription, and those are requests it
 * makes, not ones it intercepts.
 *
 * It is a classic script with no build step and no imports, so it can be served
 * as a static file with `Cache-Control: no-cache` (next.config.ts) and updated
 * by a deploy like any other asset. The pure functions at the top are exported
 * for the spec (`src/lib/push/service-worker.spec.ts`) when loaded as a module;
 * in a browser `module` does not exist and only the listeners register.
 *
 * The payload shape is `PushMessage` in `src/lib/push/payload.ts`. `version`
 * lets this file and the server move independently across a deploy: a payload
 * of a version this file does not know still shows a notification, with the
 * words it carries if they are there and a generic line if they are not.
 */
'use strict'

var INBOX_PATH = '/app/inbox'
var GENERIC_TITLE = 'Piloti'
var ICON = '/icons/icon-192.png'
var CONFIG_PATH = '/api/notifications/push/config'
var DEVICES_PATH = '/api/notifications/push/devices'
/** The inbox's read endpoint (`INBOX_READ_PATH` in `src/lib/inbox/client.ts`, which this file cannot import). */
var READ_PATH = '/api/inbox/read'
/** How long a tap waits for the read before it opens the item anyway. */
var READ_WAIT_MS = 400

/** The page-to-worker and worker-to-page message types. */
var MESSAGE_CLOSE = 'piloti:close-notifications'
var MESSAGE_NAVIGATE = 'piloti:navigate'

function isString(value) {
  return typeof value === 'string' && value.length > 0
}

/**
 * Where a tap lands: a path on this origin, or the inbox. Anything else (an
 * absolute URL, a protocol-relative one) is not a destination we sent.
 */
function safeTarget(url, origin) {
  if (!isString(url) || url.charAt(0) !== '/' || url.charAt(1) === '/' || url.indexOf('\\') !== -1) {
    return origin + INBOX_PATH
  }
  return origin + url
}

/**
 * Read the push event's payload text.
 *
 * Never throws and never returns nothing: a browser that requires every push to
 * show a notification (iOS and Chrome both do) would otherwise show its own
 * "this site has been updated in the background" line, or revoke the
 * subscription for silent pushes.
 */
function parseMessage(text) {
  var data = null
  try {
    data = text ? JSON.parse(text) : null
  } catch (error) {
    data = null
  }
  if (!data || typeof data !== 'object') data = {}
  return {
    title: isString(data.title) ? data.title : GENERIC_TITLE,
    body: isString(data.body) ? data.body : '',
    url: isString(data.url) ? data.url : INBOX_PATH,
    tag: isString(data.tag) ? data.tag : 'piloti-inbox',
    itemId: isString(data.itemId) ? data.itemId : '',
  }
}

/** The options for `showNotification`. `renotify` so a newer message in a group alerts again. */
function notificationOptions(message) {
  return {
    body: message.body,
    tag: message.tag,
    renotify: true,
    icon: ICON,
    data: { url: message.url, itemId: message.itemId },
  }
}

/**
 * Which open window to take to the item: one of ours (same origin), a focused
 * one before a visible one before any.
 */
function pickWindow(windows, origin) {
  var ours = windows.filter(function (client) {
    return isString(client.url) && client.url.indexOf(origin + '/') === 0
  })
  var focused = ours.filter(function (client) {
    return client.focused
  })
  if (focused.length > 0) return focused[0]
  var visible = ours.filter(function (client) {
    return client.visibilityState === 'visible'
  })
  return visible.length > 0 ? visible[0] : ours[0] || null
}

/**
 * Which of these notifications a close request names: all of them, the items it
 * lists (a notification remembers its inbox item in `data.itemId`), or the tags.
 */
function notificationsToClose(notifications, request) {
  if (request && request.all === true) return notifications
  var itemIds = request && Array.isArray(request.itemIds) ? request.itemIds : []
  var tags = request && Array.isArray(request.tags) ? request.tags : []
  return notifications.filter(function (notification) {
    var itemId = notification.data && notification.data.itemId
    return tags.indexOf(notification.tag) !== -1 || (isString(itemId) && itemIds.indexOf(itemId) !== -1)
  })
}

/** The standard `applicationServerKey` form of a URL-safe base64 key. */
function urlBase64ToBytes(value) {
  var padded = (value + '='.repeat((4 - (value.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/')
  var raw = atob(padded)
  var bytes = new Uint8Array(raw.length)
  for (var i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i)
  return bytes
}

function showPush(scope, event) {
  var text = event.data ? event.data.text() : ''
  var message = parseMessage(text)
  return scope.registration.showNotification(message.title, notificationOptions(message))
}

/**
 * A tap is the person opening the item, as a click on its row is: mark it read
 * on the server, with the signed-in session's cookie, before the page loads, so
 * the inbox does not still call it new. Best effort and never in the way: a
 * failure (signed out, offline, an item another tab archived) still opens it.
 */
async function markRead(itemId) {
  if (!isString(itemId)) return
  try {
    await fetch(READ_PATH, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemIds: [itemId] }),
    })
  } catch (error) {
    // Opening the item matters more than its read state.
  }
}

async function openItem(scope, rawUrl) {
  var target = safeTarget(rawUrl, scope.location.origin)
  var windows = await scope.clients.matchAll({ type: 'window', includeUncontrolled: true })
  var client = pickWindow(windows, scope.location.origin)
  if (!client) {
    if (scope.clients.openWindow) await scope.clients.openWindow(target)
    return
  }
  try {
    await client.focus()
  } catch (error) {
    // A window the browser will not focus is still told where to go.
  }
  // `navigate` is refused for a window this worker does not control; the page
  // listens for the message and routes itself.
  try {
    var navigated = client.navigate ? await client.navigate(target) : null
    if (navigated) return
  } catch (error) {
    // Fall through to the message.
  }
  client.postMessage({ type: MESSAGE_NAVIGATE, url: target.slice(scope.location.origin.length) })
}

/**
 * The push service rotated or expired the subscription. Subscribe again and
 * tell the server which address replaces which.
 *
 * Only a rotation of a device the signed-in person owns is carried over. The
 * worker posts with whoever is signed in NOW, which on a shared computer may
 * not be the person who turned notifications on, so the server refuses (409) a
 * `replaces` that is not one of the caller's own devices, and a change without
 * an old address is not carried over at all: there is nothing to prove it is
 * theirs. Either way the new subscription is dropped again, and the person turns
 * notifications back on in the settings. Signed out, the server answers 401
 * and the same happens.
 */
async function resubscribe(scope, event) {
  var oldEndpoint = event.oldSubscription && event.oldSubscription.endpoint
  if (!isString(oldEndpoint)) {
    if (event.newSubscription) await event.newSubscription.unsubscribe()
    return
  }
  var configResponse = await fetch(CONFIG_PATH, { credentials: 'same-origin', cache: 'no-store' })
  if (!configResponse.ok) return
  var config = await configResponse.json()
  if (!config || !config.enabled || !isString(config.publicKey)) return
  var subscription =
    event.newSubscription ||
    (await scope.registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToBytes(config.publicKey),
    }))
  var json = subscription.toJSON()
  var response = await fetch(DEVICES_PATH, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      endpoint: json.endpoint,
      keys: json.keys,
      replaces: oldEndpoint,
    }),
  })
  if (!response.ok) await subscription.unsubscribe()
}

function register(scope) {
  scope.addEventListener('install', function () {
    scope.skipWaiting()
  })
  scope.addEventListener('activate', function (event) {
    event.waitUntil(scope.clients.claim())
  })
  scope.addEventListener('push', function (event) {
    event.waitUntil(showPush(scope, event))
  })
  scope.addEventListener('notificationclick', function (event) {
    event.notification.close()
    var data = event.notification.data || {}
    // The read is sent first and given a moment to land before the page loads,
    // never longer: a browser lets a tap open a window only for a short while.
    var reading = markRead(data.itemId)
    var settled = new Promise(function (resolve) {
      setTimeout(resolve, READ_WAIT_MS)
    })
    event.waitUntil(
      Promise.all([
        reading,
        Promise.race([reading, settled]).then(function () {
          return openItem(scope, data.url)
        }),
      ])
    )
  })
  scope.addEventListener('pushsubscriptionchange', function (event) {
    event.waitUntil(resubscribe(scope, event))
  })
  scope.addEventListener('message', function (event) {
    var request = event.data
    if (!request || request.type !== MESSAGE_CLOSE) return
    event.waitUntil(
      scope.registration.getNotifications().then(function (notifications) {
        notificationsToClose(notifications, request).forEach(function (notification) {
          notification.close()
        })
      })
    )
  })
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    MESSAGE_CLOSE: MESSAGE_CLOSE,
    MESSAGE_NAVIGATE: MESSAGE_NAVIGATE,
    READ_PATH: READ_PATH,
    notificationOptions: notificationOptions,
    notificationsToClose: notificationsToClose,
    markRead: markRead,
    openItem: openItem,
    parseMessage: parseMessage,
    pickWindow: pickWindow,
    register: register,
    resubscribe: resubscribe,
    safeTarget: safeTarget,
    urlBase64ToBytes: urlBase64ToBytes,
  }
} else if (typeof self !== 'undefined') {
  register(self)
}
