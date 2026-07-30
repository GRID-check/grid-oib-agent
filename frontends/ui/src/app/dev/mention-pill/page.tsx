'use client'

/**
 * Dev preview for the mention pill and the person card behind it.
 *
 * The REAL `MentionText` inside a real `MentionPeopleProvider`, so the screenshot
 * is evidence about the shipping component and not about a mock. Four rows, each a
 * distinct decision:
 *
 *   1. a colleague — the quiet reference;
 *   2. YOU — the one mention that asks something of the reader, so it is filled ink;
 *   3. Piloti — the assistant, tinted between the two;
 *   4. someone no longer in the roster — deliberately NOT interactive, because a
 *      pill that opens an empty panel is worse than plain text.
 *
 * Plus the card itself, rendered open beside them: a popover cannot be captured in
 * a static screenshot, so `PersonPeek` is shown directly in the three shapes it
 * takes. What the pill opens and what is shown here is the same component.
 *
 * Not linked from anywhere; 404s outside development. Pinned to German — the
 * product's primary language — so the evidence carries the copy that ships.
 */

import { notFound } from 'next/navigation'

import { MentionText } from '@/features/collaboration/components/MentionText'
import { PersonPeek } from '@/features/collaboration/components/PersonPeek'
import { MentionPeopleProvider } from '@/features/collaboration/context/mention-people'
import { I18nProvider } from '@/i18n'
import { AGENT_MENTION_ID } from '@/lib/mentions/types'

const person = (userId: string, name: string) => ({
  userId,
  name,
  email: `${name.toLowerCase().replace(/\s+/g, '.')}@arch-buero.at`,
  profilePictureUrl: null,
})

const ME = person('u-matthias', 'Matthias Bigl')
const ANNA = person('u-anna', 'Anna Weber')
const SABINE = person('u-sabine', 'Sabine Gruber')

const ROSTER = [ME, ANNA, SABINE]

const Row = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <section className="flex flex-col gap-1.5">
    <h2 className="text-muted-foreground text-[10.5px] font-medium uppercase tracking-wider">
      {label}
    </h2>
    <p className="text-foreground text-sm leading-relaxed">{children}</p>
  </section>
)

export default function MentionPillPreviewPage() {
  if (process.env.NODE_ENV !== 'development') {
    notFound()
  }

  return (
    <I18nProvider initialLocale="de" fixedLocale>
      <MentionPeopleProvider participants={ROSTER} currentUserId={ME.userId} agentName="Piloti">
        <main
          data-testid="mention-pill-preview"
          className="mx-auto flex w-full max-w-3xl flex-col gap-8 p-6 md:p-8"
        >
          <header>
            <h1 className="text-xl font-semibold tracking-tight">Erwähnungen im Chat</h1>
            <p className="text-muted-foreground mt-1 text-sm">
              Eine Erwähnung verweist auf eine Person — und beantwortet im Vorbeigehen, wer das ist.
            </p>
          </header>

          <div className="flex flex-col gap-6">
            <Row label="Eine Kollegin">
              <MentionText
                content="@Anna Weber kannst du die Fluchtwegbreite im Kern B bestätigen?"
                mentions={[{ targetId: ANNA.userId, display: ANNA.name }]}
                currentUserId={ME.userId}
              />
            </Row>

            <Row label="Sie wurden erwähnt">
              <MentionText
                content="Danke — @Matthias Bigl, das passt aus meiner Sicht."
                mentions={[{ targetId: ME.userId, display: ME.name }]}
                currentUserId={ME.userId}
              />
            </Row>

            <Row label="Der Assistent">
              <MentionText
                content="@Piloti bitte auf dieser Grundlage weiterarbeiten."
                mentions={[{ targetId: AGENT_MENTION_ID, display: 'Piloti' }]}
                currentUserId={ME.userId}
              />
            </Row>

            <Row label="Nicht mehr im Chat — bleibt bewusst ohne Karte">
              <MentionText
                content="@Tobias Kern hatte das im Frühjahr geprüft."
                mentions={[{ targetId: 'u-tobias', display: 'Tobias Kern' }]}
                currentUserId={ME.userId}
              />
            </Row>
          </div>

          <div className="flex flex-col gap-3">
            <h2 className="text-muted-foreground text-[10.5px] font-medium uppercase tracking-wider">
              Die Karte hinter der Erwähnung
            </h2>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="bg-popover w-64 rounded-2xl border p-3 shadow-md">
                <PersonPeek person={SABINE} isParticipant />
              </div>
              <div className="bg-popover w-64 rounded-2xl border p-3 shadow-md">
                <PersonPeek person={ANNA} isParticipant={false} />
              </div>
              <div className="bg-popover w-64 rounded-2xl border p-3 shadow-md">
                <PersonPeek person={ME} isYou isParticipant />
              </div>
              <div className="bg-popover w-64 rounded-2xl border p-3 shadow-md">
                <PersonPeek person={{ userId: AGENT_MENTION_ID, name: 'Piloti' }} isAgent />
              </div>
            </div>
          </div>
        </main>
      </MentionPeopleProvider>
    </I18nProvider>
  )
}
