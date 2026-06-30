import { getLinkedInSnapshot } from "@/lib/linkedin";
import { Panel } from "@/components/panel";
import Scramble from "@/components/scramble";
import { TransitionLink } from "@/components/transition-link";
import { profile } from "@/lib/profile";
import { EXTERNAL_LINK_ARROW } from "@/lib/symbols";

function formatDate(value: string | undefined) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function truncate(value: string | undefined, max = 180) {
  if (!value) return undefined;
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 3)).trimEnd()}...`;
}

function compactLanguage(value: string) {
  return value
    .replace(
      /\s+(native or bilingual proficiency|full professional proficiency|professional working proficiency|limited working proficiency|elementary proficiency).*$/i,
      "",
    )
    .trim();
}

function getSectionItems(
  sections: Array<{ title: string; items: string[] }>,
  title: string,
) {
  return sections.find((section) => section.title.toLowerCase() === title.toLowerCase())?.items ?? [];
}

export default async function AboutPage() {
  const linkedIn = await getLinkedInSnapshot();
  const profileSections = linkedIn.sections ?? [];
  const hiddenStackItems = new Set([
    "react",
    "shopify",
    "gemini",
    "claude",
    "llama",
    "fireworks ai",
    "fireworks",
    "fireworks.js",
  ]);
  const preferredStackAdds = ["Redis", "FastAPI", "Docker", "AWS", "Bun"];
  const baseStack = (linkedIn.profile.technologies ?? []).filter(
    (item) => !hiddenStackItems.has(item.trim().toLowerCase()),
  );
  const displayStack = [...baseStack];
  for (const item of preferredStackAdds) {
    const exists = displayStack.some((entry) => entry.trim().toLowerCase() === item.toLowerCase());
    if (!exists) displayStack.push(item);
  }
  const topPosts = linkedIn.posts.slice(0, 6);

  const languageItems = getSectionItems(profileSections, "Languages");
  const languageLine = [...new Set(languageItems.map(compactLanguage).filter(Boolean))].join(" · ");

  return (
    <main className="mx-auto min-h-screen w-full max-w-6xl px-5 py-10 md:px-8 md:py-12">
      <Panel title="session" index={0} className="mb-6">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div className="flex items-center gap-2 leading-none">
            <p className="text-sm font-medium tracking-tight text-[var(--accent)]">xiao.sh</p>
            <span aria-hidden="true" className="h-3 w-px bg-[var(--line)]" />
            <p className="relative top-px text-[10px] uppercase tracking-[0.14em] text-[var(--muted)]">
              synced with linkedin
            </p>
          </div>
          <nav className="flex items-center gap-3 text-[11px] uppercase tracking-[0.14em] text-[var(--muted)]">
            <TransitionLink href="/" className="tui-chip">
              home
            </TransitionLink>
            <TransitionLink href="/chat" className="tui-chip">
              chat
            </TransitionLink>
            <a
              href={linkedIn.profile.linkedinUrl || profile.links.linkedin}
              target="_blank"
              rel="noreferrer"
              className="tui-chip"
            >
              linkedin {EXTERNAL_LINK_ARROW}
            </a>
          </nav>
        </div>
      </Panel>

      <Panel title="cat about" index={1}>
        <div className="mt-1 flex flex-col gap-5 md:flex-row md:items-stretch">
          {linkedIn.profile.imageUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={linkedIn.profile.imageUrl}
              alt={linkedIn.profile.name}
              className="h-24 w-24 border border-[var(--line)] object-cover md:h-auto md:w-28"
            />
          )}
          <div className="min-w-0">
            <Scramble as="h1" className="text-3xl font-semibold tracking-tight md:text-4xl" text={linkedIn.profile.name} />
            {linkedIn.profile.title && (
              <p className="mt-2 text-sm text-[var(--muted)] md:text-base">{linkedIn.profile.title}</p>
            )}

            <div className="mt-3 flex flex-wrap gap-2 text-[11px] uppercase tracking-[0.12em] text-[var(--muted)]">
              <span className="border border-[var(--line)] px-2 py-1">{profile.education}</span>
              {linkedIn.profile.location && (
                <span className="border border-[var(--line)] px-2 py-1">{linkedIn.profile.location}</span>
              )}
              {typeof linkedIn.profile.followerCount === "number" && (
                <span className="border border-[var(--line)] px-2 py-1">
                  {linkedIn.profile.followerCount.toLocaleString()} followers
                </span>
              )}
            </div>

            <p className="mt-3 text-xs uppercase tracking-[0.12em] text-[var(--muted)]">
              Source: {linkedIn.source ?? "linkedin"} · Pulled {formatDate(linkedIn.pulledAt) ?? linkedIn.pulledAt}
            </p>
          </div>
        </div>
      </Panel>

      <Panel title="languages" index={2} className="mt-6">
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs uppercase tracking-[0.16em] text-[var(--muted)]">languages</p>
          <p className="text-xs text-[var(--muted)]">{languageItems.length} entries</p>
        </div>
        {languageItems.length > 0 ? (
          <p className="mt-3 text-sm leading-relaxed text-[var(--muted)]">{languageLine}</p>
        ) : (
          <p className="mt-3 text-sm text-[var(--muted)]">No languages are listed on the current profile data.</p>
        )}
      </Panel>

      <Panel title="contact" index={3} className="mt-6">
        <div className="grid gap-2 text-sm text-[var(--muted)] md:grid-cols-2">
          <p>
            <span className="text-[var(--text)]">Email:</span>{" "}
            <a href={`mailto:${profile.links.email}`} className="hover:text-[var(--text)]">
              {profile.links.email}
            </a>
          </p>
          <p>
            <span className="text-[var(--text)]">DOB:</span> {profile.dob?.trim() ? profile.dob : "Not listed"}
          </p>
          <p>
            <span className="text-[var(--text)]">GitHub:</span>{" "}
            <a href={profile.links.github} target="_blank" rel="noreferrer" className="hover:text-[var(--text)]">
              {profile.links.github}
            </a>
          </p>
          <p>
            <span className="text-[var(--text)]">LinkedIn:</span>{" "}
            <a href={profile.links.linkedin} target="_blank" rel="noreferrer" className="hover:text-[var(--text)]">
              {profile.links.linkedin}
            </a>
          </p>
        </div>
      </Panel>

      <Panel title="stack" index={4} className="mt-6">
        <p className="text-sm leading-relaxed text-[var(--muted)]">
          {displayStack.length > 0 ? displayStack.slice(0, 12).join(" · ") : profile.skills.join(" · ")}
        </p>
      </Panel>

      <Panel title="posts" index={5} className="mt-6">
        <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
          <p className="text-xs uppercase tracking-[0.16em] text-[var(--muted)]">linkedin posts</p>
          <p className="text-xs text-[var(--muted)]">{topPosts.length} shown</p>
        </div>

        <div className="mt-4 space-y-3">
          {topPosts.map((post) => (
            <article key={post.url} className="border border-[var(--line)] bg-[var(--panel-2)] p-4">
              <div className="flex items-start justify-between gap-3">
                <h2 className="text-sm font-medium tracking-tight md:text-base">
                  {truncate(post.headline || "LinkedIn Post", 120)}
                </h2>
                {post.publishedAt && (
                  <span className="shrink-0 text-[10px] uppercase tracking-[0.12em] text-[var(--muted)]">
                    {formatDate(post.publishedAt)}
                  </span>
                )}
              </div>

              {post.excerpt && (
                <p className="mt-2 text-sm leading-relaxed text-[var(--muted)]">
                  {truncate(post.excerpt, 200)}
                </p>
              )}

              <div className="mt-3 flex flex-wrap gap-2">
                <a
                  href={post.url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-block border border-[var(--line)] px-2 py-1 text-[11px] uppercase tracking-[0.12em] hover:border-[var(--accent)] hover:text-[var(--accent)]"
                >
                  Open Post {EXTERNAL_LINK_ARROW}
                </a>
                {post.videoUrl && (
                  <a
                    href={post.videoUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-block border border-[var(--line)] px-2 py-1 text-[11px] uppercase tracking-[0.12em] hover:border-[var(--accent)] hover:text-[var(--accent)]"
                  >
                    Video {EXTERNAL_LINK_ARROW}
                  </a>
                )}
              </div>
            </article>
          ))}
        </div>
      </Panel>
    </main>
  );
}
