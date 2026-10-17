import type { en } from '../en'

/**
 * System notifications for the inbox (Web Push, ADR-0112): the settings
 * section, the prompt in the inbox, and the one line a notification carries
 * when the person asked for no preview.
 */
export const notifications: typeof en.notifications = {
  title: 'Benachrichtigungen',
  description:
    'Piloti meldet sich auf diesem Gerät, sobald etwas in Ihrem Postfach landet, auch wenn Piloti nicht geöffnet ist.',
  push: {
    genericTitle: 'Neue Nachricht in Piloti',
  },
  device: {
    label: 'Auf diesem Gerät benachrichtigen',
    hint: 'Ihr Browser fragt einmal nach der Erlaubnis. Hier schalten Sie es jederzeit wieder aus; beim Abmelden wird es auf diesem Gerät ebenfalls ausgeschaltet.',
    turnOn: 'Einschalten',
    turnOff: 'Ausschalten',
    working: 'Einen Moment …',
    on: 'Für dieses Gerät eingeschaltet',
    failed: 'Die Benachrichtigungen konnten nicht eingeschaltet werden. Bitte versuchen Sie es erneut.',
    removeFailed: 'Das Gerät konnte nicht entfernt werden. Bitte versuchen Sie es erneut.',
  },
  states: {
    unsupported: {
      title: 'Dieser Browser kann keine Benachrichtigungen anzeigen',
      body: 'Verwenden Sie eine aktuelle Version von Chrome, Edge, Firefox oder Safari, um hier benachrichtigt zu werden.',
    },
    denied: {
      title: 'Benachrichtigungen sind für Piloti blockiert',
      body: 'Erlauben Sie sie im Browser: Öffnen Sie neben der Adresse die Website-Einstellungen (Schloss-Symbol), stellen Sie „Benachrichtigungen“ auf „Zulassen“ und laden Sie diese Seite neu.',
    },
    needsInstall: {
      title: 'Zuerst zum Home-Bildschirm hinzufügen',
      body: 'Auf iPhone und iPad funktionieren Benachrichtigungen nur für eine installierte App. Tippen Sie in Safari auf „Teilen“ und wählen Sie „Zum Home-Bildschirm“. Öffnen Sie Piloti von dort und schalten Sie sie hier ein.',
    },
  },
  devices: {
    title: 'Ihre Geräte',
    empty: 'Noch kein Gerät erhält Benachrichtigungen.',
    thisDevice: 'Dieses Gerät',
    lastDelivered: 'Zuletzt benachrichtigt {time}',
    neverDelivered: 'Noch nichts zugestellt',
    remove: 'Entfernen',
    removeLabel: '{device} entfernen',
  },
  categories: {
    title: 'Worüber Piloti Sie benachrichtigt',
    requests: {
      label: 'Anfragen an Sie',
      hint: 'Jemand bittet um Ihre Einschätzung, Piloti hat eine Rückfrage, etwas wartet auf Ihre Entscheidung.',
    },
    results: {
      label: 'Ergebnisse',
      hint: 'Fertige Hintergrundarbeit, was dabei schiefging, und Antworten auf Ihre Fragen und Anmerkungen.',
    },
    access: {
      label: 'Zugriff und Zuweisungen',
      hint: 'Ein Chat wird mit Ihnen geteilt, Ihnen wird eine Datei oder eine Anmerkung zugewiesen.',
    },
    activity: {
      label: 'Aktivität',
      hint: 'Neue Nachrichten in Chats, fertige Uploads, neue Fassungen von Dokumenten, denen Sie folgen.',
    },
    office: {
      label: 'Hinweise zum Büro',
      hint: 'Speicher, zurückgehaltene Dateien und anderes, das Ihr Büro betrifft.',
    },
  },
  preview: {
    label: 'Inhalt auf dem Sperrbildschirm zeigen',
    hint: 'Ausgeschaltet steht dort nur, dass etwas eingegangen ist, ohne Namen und Betreff.',
  },
  preferencesFailed: 'Ihre Auswahl konnte nicht gespeichert werden. Bitte versuchen Sie es erneut.',
  prompt: {
    title: 'Bei Neuem benachrichtigt werden?',
    body: 'Piloti meldet sich auf diesem Gerät, wenn jemand Sie braucht.',
    turnOn: 'Einschalten',
    dismiss: 'Nicht jetzt',
    // Der Browser hat Nein gesagt: ein Satz, der dorthin führt, wo steht, wie
    // man es ändert (das Profil).
    blocked: 'Benachrichtigungen sind blockiert – so schalten Sie sie ein',
  },
  // Dasselbe Angebot, einmal als Hinweis, wenn zum ersten Mal etwas auf Sie
  // wartet: für alle, die das Postfach nie öffnen.
  offer: {
    mentioned: '{actor} hat Sie erwähnt. Möchten Sie auf diesem Gerät benachrichtigt werden?',
    actor: '{actor} braucht Sie in Piloti. Möchten Sie auf diesem Gerät benachrichtigt werden?',
    someone: 'Jemand braucht Sie in Piloti. Möchten Sie auf diesem Gerät benachrichtigt werden?',
    turnOn: 'Einschalten',
    notNow: 'Nicht jetzt',
  },
}
